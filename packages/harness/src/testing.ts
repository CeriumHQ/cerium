import type { CapabilityManifest, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { Deferred, Duration, Effect, Queue, Stream, type Cause } from "effect";

import {
  HarnessFailure,
  HarnessUnavailable,
  type AdapterEvent,
  type CompletionRequest,
  type HarnessAdapter,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "./adapter.ts";

// Test support shared by every package that drives harness sessions without a real provider.

export interface FakeSession {
  readonly options: SessionOptions;
  readonly sent: Array<string>;
  /** What each turn carried beside its text, in the same order. */
  readonly extras: Array<TurnExtras | undefined>;
  /** Each `setModel` and `setEffort` the session took, in order. */
  readonly switches: Array<{ readonly model: string } | { readonly effort: ReasoningEffort }>;
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
    /** Whether the manifest takes images (default false). */
    readonly images?: boolean;
    /** How long each session takes to start. */
    readonly startDuration?: Duration.Input;
    /** How many of the first sessions fail to start, as a logged-out harness would. */
    readonly failedStarts?: number;
    /** What `complete` answers; without it, `complete` fails as a logged-out harness would. */
    readonly complete?: (request: CompletionRequest) => string;
    /** How long each `complete` takes. */
    readonly completeDuration?: Duration.Input;
    /** What the manifest says sessions can switch (default: model and effort). */
    readonly switching?: { readonly model: boolean; readonly effort: boolean };
    /** `setModel` and `setEffort` fail, as a harness refusing a model would. */
    readonly refuseSwitches?: boolean;
  } = {},
) => {
  const sessions: Array<FakeSession> = [];
  const completions: Array<CompletionRequest> = [];
  let failuresLeft = options.failedStarts ?? 0;
  const running = { now: 0, max: 0 };
  const manifest: CapabilityManifest = {
    provider,
    harnessVersion: { minimum: "1.0.0", testedMaximum: "1.0.0" },
    session: { resume: true, fork: false },
    switching: { model: true, effort: true, ...options.switching, cacheSafeEffort: true },
    input: { images: options.images ?? false },
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
    complete: (request) =>
      Effect.gen(function* () {
        completions.push(request);
        yield* Effect.sleep(options.completeDuration ?? 0);
        if (options.complete === undefined) {
          return yield* new HarnessUnavailable({ provider, reason: "loggedOut", message: "Not logged in." });
        }
        return options.complete(request);
      }),
    startSession: (sessionOptions) =>
      Effect.gen(function* () {
        yield* Effect.sleep(options.startDuration ?? 0);
        if (failuresLeft > 0) {
          failuresLeft--;
          return yield* new HarnessUnavailable({ provider, reason: "loggedOut", message: "Not logged in." });
        }
        const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
        yield* Effect.addFinalizer(() => Queue.end(events));
        const session: FakeSession = { options: sessionOptions, sent: [], extras: [], switches: [] };
        const switchTo = (change: FakeSession["switches"][number]) =>
          options.refuseSwitches
            ? Effect.fail(
                new HarnessFailure({ provider, message: "That model isn't available.", cause: null }),
              )
            : Effect.sync(() => void session.switches.push(change));
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
          send: (text: string, extras?: TurnExtras) =>
            Effect.sync(() => {
              session.sent.push(text);
              session.extras.push(extras);
            }).pipe(Effect.andThen(Effect.forkDetach(turn(text))), Effect.asVoid),
          respondToPermission: (requestId: string, decision: PermissionDecision) =>
            Effect.suspend(() => {
              const pending = decisions.get(requestId);
              return pending === undefined
                ? Effect.void
                : Deferred.succeed(pending, decision).pipe(Effect.asVoid);
            }),
          interrupt: Effect.void,
          setModel: (model: string) => switchTo({ model }),
          setEffort: (effort: ReasoningEffort) => switchTo({ effort }),
        };
      }),
  };
  return { adapter, sessions, completions, running };
};
