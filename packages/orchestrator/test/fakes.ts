import type { AdapterEvent, HarnessAdapter, SessionOptions } from "@cerium/harness";
import type { AgentEvent, CapabilityManifest, ProviderId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Adapters,
  BusEndpoint,
  Catalog,
  Orchestrator,
  OrchestratorConfig,
  type CatalogEntry,
} from "../src/index.ts";

export interface FakeSession {
  readonly options: SessionOptions;
  readonly sent: Array<string>;
}

/** A scripted harness: every turn replies `reply(text)` after `turnDuration`, then completes. */
export const makeFakeAdapter = (
  provider: ProviderId,
  options: {
    readonly concurrency?: number;
    readonly turnDuration?: Duration.Input;
    readonly reply?: (text: string, session: SessionOptions) => string;
  } = {},
) => {
  const sessions: Array<FakeSession> = [];
  const running = { now: 0, max: 0 };
  const manifest: CapabilityManifest = {
    provider,
    harnessVersion: { minimum: "1.0.0", testedMaximum: "1.0.0" },
    session: { resume: true, fork: false },
    switching: { model: true, effort: true, cacheSafeEffort: true },
    input: { images: false },
    permissions: { approvals: "callback", readOnlyMode: true },
    mcpInjection: true,
    nativeSubagents: "disableable",
    usageReporting: "tokens",
    defaultConcurrency: options.concurrency ?? 6,
  };
  const adapter: HarnessAdapter = {
    provider,
    manifest,
    probe: Effect.die("unused"),
    startSession: (sessionOptions) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
        yield* Effect.addFinalizer(() => Queue.end(events));
        const session: FakeSession = { options: sessionOptions, sent: [] };
        sessions.push(session);
        yield* Queue.offer(events, {
          payload: {
            _tag: "SessionStarted",
            provider,
            providerSessionId: `fake-${sessions.length}`,
            model: sessionOptions.model,
          },
        });
        const turn = (text: string) =>
          Effect.gen(function* () {
            running.now++;
            running.max = Math.max(running.max, running.now);
            yield* Effect.sleep(options.turnDuration ?? 0);
            running.now--;
            const messageId = `m${session.sent.length}`;
            const reply = options.reply?.(text, sessionOptions) ?? `reply to: ${text.slice(0, 40)}`;
            yield* Queue.offer(events, { payload: { _tag: "MessageDelta", messageId, text: reply } });
            yield* Queue.offer(events, { payload: { _tag: "MessageCompleted", messageId, text: reply } });
            yield* Queue.offer(events, { payload: { _tag: "TurnCompleted", stopReason: "completed" } });
          });
        return {
          events: Stream.fromQueue(events),
          send: (text: string) =>
            Effect.sync(() => session.sent.push(text)).pipe(
              Effect.andThen(Effect.forkDetach(turn(text))),
              Effect.asVoid,
            ),
          respondToPermission: () => Effect.void,
          interrupt: Effect.void,
          setModel: () => Effect.void,
          setEffort: () => Effect.void,
        };
      }),
  };
  return { adapter, sessions, running };
};

export const fakeBus = Layer.succeed(BusEndpoint, {
  serverName: "cerium",
  register: (agentId) => Effect.succeed({ type: "http" as const, url: `http://bus.test/${agentId}` }),
  unregister: () => Effect.void,
});

export const testLayer = (
  adapters: ReadonlyArray<HarnessAdapter>,
  options: { readonly catalog?: ReadonlyArray<CatalogEntry>; readonly messageLimit?: number } = {},
) =>
  Orchestrator.layer.pipe(
    Layer.provideMerge(
      Store.layer({
        filename: ":memory:",
        migrationsFolder: join(import.meta.dirname, "../../store/migrations"),
      }),
    ),
    Layer.provide(Adapters.fromList(adapters)),
    Layer.provide(Catalog.fromEntries(options.catalog ?? [])),
    Layer.provide(fakeBus),
    Layer.provide(
      OrchestratorConfig.layer({
        chatDirectory: mkdtempSync(join(tmpdir(), "cerium-chat-")),
        batchWindow: Duration.millis(20),
        messageBudget: { limit: options.messageLimit ?? 10, window: Duration.minutes(30) },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Records every live event and waits for conditions on them. */
export const recordEvents = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const seen: Array<AgentEvent> = [];
  yield* orchestrator.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
    Effect.forkScoped,
  );
  // Let the subscription start before the test acts.
  yield* Effect.sleep(Duration.millis(5));
  const waitFor = <A>(find: (events: ReadonlyArray<AgentEvent>) => A | undefined) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = find(seen);
        if (found !== undefined) return found;
        yield* Effect.sleep(Duration.millis(5));
      }
      return yield* Effect.die(new Error("Timed out waiting for an event"));
    });
  return { seen, waitFor };
});
