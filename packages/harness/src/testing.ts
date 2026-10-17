import type { CapabilityManifest, ProviderId } from "@cerium/protocol";
import { Deferred, Duration, Effect, Queue, Stream, type Cause } from "effect";

import type { AdapterEvent, HarnessAdapter, PermissionDecision, SessionOptions } from "./adapter.ts";

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
    /** Each turn asks to run a command and waits for the decision before replying. */
    readonly askPermission?: boolean;
    /** The tool those requests are for (default `Bash`). */
    readonly permissionTool?: string;
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
    listModels: Effect.succeed([
      { provider, id: "fake-model", label: "Fake model", efforts: ["low", "medium", "high"] },
    ]),
    startSession: (sessionOptions) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
        yield* Effect.addFinalizer(() => Queue.end(events));
        const session: FakeSession = { options: sessionOptions, sent: [] };
        const decisions = new Map<string, Deferred.Deferred<PermissionDecision>>();
        sessions.push(session);
        yield* Queue.offer(events, {
          payload: {
            _tag: "SessionStarted",
            provider,
            providerSessionId: sessionOptions.resume ?? `fake-${sessions.length}`,
            model: sessionOptions.model,
          },
        });
        const turn = (text: string) =>
          Effect.gen(function* () {
            running.now++;
            running.max = Math.max(running.max, running.now);
            yield* Effect.sleep(options.turnDuration ?? 0);
            running.now--;
            if (options.askPermission) {
              const requestId = `p${session.sent.length}`;
              const decision = yield* Deferred.make<PermissionDecision>();
              decisions.set(requestId, decision);
              yield* Queue.offer(events, {
                payload: {
                  _tag: "PermissionRequested",
                  requestId,
                  toolName: options.permissionTool ?? "Bash",
                  summary: "Run tests",
                  input: {},
                },
              });
              const { decision: verdict, scope } = yield* Deferred.await(decision);
              yield* Queue.offer(events, {
                payload: { _tag: "PermissionResolved", requestId, decision: verdict, scope },
              });
            }
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
          respondToPermission: (requestId: string, decision: PermissionDecision) =>
            Effect.suspend(() => {
              const pending = decisions.get(requestId);
              return pending === undefined
                ? Effect.void
                : Deferred.succeed(pending, decision).pipe(Effect.asVoid);
            }),
          interrupt: Effect.void,
          setModel: () => Effect.void,
          setEffort: () => Effect.void,
        };
      }),
  };
  return { adapter, sessions, running };
};
