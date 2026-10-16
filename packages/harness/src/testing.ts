import type { CapabilityManifest, ProviderId } from "@cerium/protocol";
import { Duration, Effect, Queue, Stream, type Cause } from "effect";

import type { AdapterEvent, HarnessAdapter, SessionOptions } from "./adapter.ts";

// Test support shared by every package that drives harness sessions without a real provider.

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
