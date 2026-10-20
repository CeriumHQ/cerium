import { HarnessFailure, HarnessUnavailable, type HarnessAdapter } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";
import type { ProviderId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { subscriptionUsage } from "../src/usage.ts";

const withUsage = (provider: ProviderId, usage?: HarnessAdapter["usage"]): HarnessAdapter => ({
  ...makeFakeAdapter(provider).adapter,
  ...(usage === undefined ? {} : { usage }),
});

const meter = { label: "Current session", usedPercent: 40, resetsAt: 5_000 };

describe("subscriptionUsage", () => {
  it.effect("lists subscribed harnesses and says why one couldn't be read", () =>
    Effect.gen(function* () {
      const adapters = [
        withUsage("claude", Effect.succeedSome({ plan: "max", meters: [meter] })),
        withUsage(
          "codex",
          Effect.fail(
            new HarnessFailure({ provider: "codex", message: "Could not read Codex's usage", cause: null }),
          ),
        ),
        withUsage("muse", Effect.succeedNone),
        withUsage(
          "cursor",
          Effect.fail(
            new HarnessUnavailable({ provider: "cursor", reason: "loggedOut", message: "Log in." }),
          ),
        ),
      ];
      const usage = yield* subscriptionUsage(new Map(adapters.map((adapter) => [adapter.provider, adapter])));
      assert.deepStrictEqual(usage, [
        { _tag: "Subscribed", provider: "claude", plan: "max", meters: [meter], checkedAt: 0 },
        { _tag: "UsageUnreadable", provider: "codex", message: "Could not read Codex's usage" },
      ]);
    }),
  );

  it.effect("leaves out harnesses that can't report usage, and gives up on one that hangs", () =>
    Effect.gen(function* () {
      const adapters = [withUsage("cursor"), withUsage("claude", Effect.never)];
      const fiber = yield* subscriptionUsage(
        new Map(adapters.map((adapter) => [adapter.provider, adapter])),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Fiber.join(fiber), [
        {
          _tag: "UsageUnreadable",
          provider: "claude",
          message: "The harness didn't report its usage in time.",
        },
      ]);
    }),
  );
});
