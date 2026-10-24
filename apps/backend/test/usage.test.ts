import { HarnessFailure, HarnessUnavailable, type HarnessAdapter } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";
import type {
  AgentEvent,
  AgentId,
  EventPayload,
  ProviderId,
  ThreadId,
  UsageSnapshot,
} from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Option, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeSubscriptionUsage, nextReading, readProviderUsage } from "../src/usage.ts";

const withUsage = (provider: ProviderId, usage?: HarnessAdapter["usage"]): HarnessAdapter => ({
  ...makeFakeAdapter(provider).adapter,
  ...(usage === undefined ? {} : { usage }),
});

const meter = { label: "Current session", usedPercent: 40, resetsAt: 5_000 };

const event = (agentId: string, payload: EventPayload): AgentEvent => ({
  id: `e-${agentId}-${payload._tag}` as AgentEvent["id"],
  threadId: "thr_1" as ThreadId,
  agentId: agentId as AgentId,
  sequence: 0,
  at: 0,
  payload,
});

describe("readProviderUsage", () => {
  it.effect("reads a subscription, leaves out a harness without one, and says why a read failed", () =>
    Effect.gen(function* () {
      const read = (adapter: HarnessAdapter) =>
        readProviderUsage(adapter).pipe(Effect.map(Option.getOrUndefined));
      assert.deepStrictEqual(
        yield* read(
          withUsage("claude", Effect.succeedSome({ plan: "max", meters: [meter], resetCredits: 2 })),
        ),
        {
          _tag: "Subscribed",
          provider: "claude",
          plan: "max",
          meters: [meter],
          resetCredits: 2,
          checkedAt: 0,
        },
      );
      assert.deepStrictEqual(
        yield* read(
          withUsage(
            "codex",
            Effect.fail(
              new HarnessFailure({ provider: "codex", message: "Could not read Codex's usage", cause: null }),
            ),
          ),
        ),
        { _tag: "UsageUnreadable", provider: "codex", message: "Could not read Codex's usage" },
      );
      assert.isUndefined(yield* read(withUsage("muse", Effect.succeedNone)));
      assert.isUndefined(yield* read(withUsage("cursor")));
      assert.isUndefined(
        yield* read(
          withUsage(
            "cursor",
            Effect.fail(
              new HarnessUnavailable({ provider: "cursor", reason: "loggedOut", message: "Log in." }),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("gives up on a harness that doesn't answer", () =>
    Effect.gen(function* () {
      const fiber = yield* readProviderUsage(withUsage("claude", Effect.never)).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(Option.getOrUndefined(yield* Fiber.join(fiber)), {
        _tag: "UsageUnreadable",
        provider: "claude",
        message: "The harness didn't report its usage in time.",
      });
    }),
  );
});

describe("nextReading", () => {
  it("keeps the last meters through a failed read, and says why", () => {
    const last = { _tag: "Subscribed" as const, provider: "claude" as const, meters: [meter], checkedAt: 10 };
    const unreadable = { _tag: "UsageUnreadable" as const, provider: "claude" as const, message: "Offline." };
    const failed = Option.some(unreadable);
    assert.deepStrictEqual(nextReading(last, failed), { ...last, refreshError: "Offline." });
    assert.deepStrictEqual(nextReading(undefined, failed), unreadable);
    assert.isUndefined(nextReading(last, Option.none()));
  });
});

describe("makeSubscriptionUsage", () => {
  it.effect("reads when watched, and again once a watched harness's turns end", () =>
    Effect.gen(function* () {
      const reads: Array<ProviderId> = [];
      const counted = (provider: ProviderId) =>
        withUsage(
          provider,
          Effect.sync(() => {
            reads.push(provider);
            return Option.some({ meters: [{ ...meter, usedPercent: reads.length * 10 }] });
          }),
        );
      const events = yield* PubSub.unbounded<AgentEvent>();
      const adapters = [counted("claude"), counted("codex")];
      const usage = yield* makeSubscriptionUsage(
        new Map(adapters.map((adapter) => [adapter.provider, adapter])),
        Stream.fromPubSub(events),
      );

      // Nobody watching: turns read nothing.
      yield* PubSub.publish(events, event("a1", { _tag: "TurnCompleted", stopReason: "completed" }));
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(reads, []);

      const seen: Array<UsageSnapshot> = [];
      yield* usage.watch.pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => seen.push(snapshot))),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      assert.sameMembers(reads, ["claude", "codex"]);
      const settled = seen.at(-1);
      assert.isFalse(settled?.checking);
      assert.deepStrictEqual(
        settled?.usage.map((each) => each.provider),
        ["claude", "codex"],
      );

      // A Codex agent's turn ends: only Codex is read again, once its turns settle.
      yield* PubSub.publish(
        events,
        event("a2", { _tag: "SessionStarted", provider: "codex", providerSessionId: "s", model: "m" }),
      );
      yield* PubSub.publish(events, event("a2", { _tag: "TurnCompleted", stopReason: "completed" }));
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(reads.slice(2), ["codex"]);
    }),
  );

  it.effect("reads a harness whose turns keep ending at most once a minute, and once after them", () =>
    Effect.gen(function* () {
      let reads = 0;
      const claude = withUsage(
        "claude",
        Effect.sync(() => {
          reads += 1;
          return Option.some({ meters: [meter] });
        }),
      );
      const events = yield* PubSub.unbounded<AgentEvent>();
      const usage = yield* makeSubscriptionUsage(new Map([["claude", claude]]), Stream.fromPubSub(events));
      yield* usage.watch.pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      assert.strictEqual(reads, 1);

      yield* PubSub.publish(
        events,
        event("a1", { _tag: "SessionStarted", provider: "claude", providerSessionId: "s", model: "m" }),
      );
      const turnEnds = event("a1", { _tag: "TurnCompleted", stopReason: "completed" });
      yield* PubSub.publish(events, turnEnds);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(reads, 2);

      // Six more turns end over the next minute: one read follows them, once the minute is up.
      for (let turn = 0; turn < 6; turn++) {
        yield* PubSub.publish(events, turnEnds);
        yield* TestClock.adjust("9 seconds");
      }
      assert.strictEqual(reads, 2);
      yield* TestClock.adjust("15 seconds");
      assert.strictEqual(reads, 3);

      // No turn ended since: nothing more to read.
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(reads, 3);
    }),
  );
});
