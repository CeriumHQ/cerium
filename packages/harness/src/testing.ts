import type {
  CapabilityManifest,
  ContextCompacted,
  ModelSpeed,
  ProviderId,
  ReasoningEffort,
  TodoItem,
} from "@cerium/protocol";
import { Deferred, Duration, Effect, Fiber, Queue, Stream, type Cause } from "effect";

import {
  HarnessFailure,
  HarnessUnavailable,
  type AdapterEvent,
  type CompletionRequest,
  type ForkRequest,
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
  /** Each `setModel`, `setEffort` and `setSpeed` the session took, in order. */
  readonly switches: Array<
    { readonly model: string } | { readonly effort: ReasoningEffort } | { readonly speed: ModelSpeed }
  >;
}

/** A scripted harness: every turn replies `reply(text)` after `turnDuration`, then completes. */
export const makeFakeAdapter = (
  provider: ProviderId,
  options: {
    readonly concurrency?: number;
    readonly turnDuration?: Duration.Input;
    readonly reply?: (text: string, session: SessionOptions) => string;
    /** What each turn reports doing (tool calls, files changed) before it replies; done as it reports. */
    readonly work?: (text: string) => ReadonlyArray<AdapterEvent["payload"]>;
    /** How long the turn takes after reporting each of those, as a tool call that runs a while. */
    readonly workPause?: Duration.Input;
    /** Each turn asks to run a command and waits for the decision before replying. */
    readonly askPermission?: boolean;
    /** The tool those requests are for (default `Bash`). */
    readonly permissionTool?: string;
    /** Each turn reports these todo lists, one update after another, before it replies. */
    readonly todos?: ReadonlyArray<ReadonlyArray<TodoItem>>;
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
    /** What the manifest says sessions can switch (default: model, effort and speed). */
    readonly switching?: { readonly model?: boolean; readonly effort?: boolean; readonly speed?: boolean };
    /** `setModel`, `setEffort` and `setSpeed` fail, as a harness refusing a model would. */
    readonly refuseSwitches?: boolean;
    /** The harness can fork sessions (`forks` records each request); `"fail"` refuses every fork. */
    readonly fork?: boolean | "fail";
    /**
     * The harness compacts when asked: a turn reporting this compaction (`compactions` counts them);
     * `"fail"` refuses every request.
     */
    readonly compact?: Omit<ContextCompacted, "_tag"> | "fail";
  } = {},
) => {
  const sessions: Array<FakeSession> = [];
  const completions: Array<CompletionRequest> = [];
  const forks: Array<ForkRequest> = [];
  const compactions = { count: 0 };
  let failuresLeft = options.failedStarts ?? 0;
  const running = { now: 0, max: 0 };
  const manifest: CapabilityManifest = {
    provider,
    session: { resume: true, fork: options.fork !== undefined && options.fork !== false },
    switching: { model: true, effort: true, speed: true, ...options.switching, cacheSafeEffort: true },
    input: { images: options.images ?? false },
    permissions: { approvals: "callback", readOnlyMode: true },
    mcpInjection: true,
    nativeSubagents: "disableable",
    usageReporting: "tokens",
    ...(options.compact === undefined ? {} : { compact: true }),
    defaultConcurrency: options.concurrency ?? 6,
  };
  const compacted = options.compact;
  const adapter: HarnessAdapter = {
    provider,
    manifest,
    probe: Effect.die("unused"),
    listModels: Effect.succeed([
      {
        provider,
        id: "fake-model",
        label: "Fake model",
        efforts: ["low", "medium", "high"],
        speeds: ["standard", "fast"],
      },
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
    ...(options.fork === undefined || options.fork === false
      ? {}
      : {
          fork: (request: ForkRequest) =>
            Effect.suspend(() => {
              forks.push(request);
              return options.fork === "fail"
                ? Effect.fail(new HarnessFailure({ provider, message: "Can't fork that.", cause: null }))
                : Effect.succeed(`fork-${forks.length}`);
            }),
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
        let current: Fiber.Fiber<void, unknown> | undefined;
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
            for (const items of options.todos ?? []) {
              yield* Queue.offer(events, { payload: { _tag: "TodosUpdated", items } });
            }
            for (const payload of options.work?.(text) ?? []) {
              yield* Queue.offer(events, { payload });
              yield* Effect.sleep(options.workPause ?? 0);
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
            }).pipe(
              Effect.andThen(Effect.forkDetach(turn(text))),
              Effect.tap((fiber) => Effect.sync(() => void (current = fiber))),
              Effect.asVoid,
            ),
          respondToPermission: (requestId: string, decision: PermissionDecision) =>
            Effect.suspend(() => {
              const pending = decisions.get(requestId);
              return pending === undefined
                ? Effect.void
                : Deferred.succeed(pending, decision).pipe(Effect.asVoid);
            }),
          // A turn still going ends where it is, as a harness's does.
          interrupt: Effect.suspend(() =>
            current === undefined || current.pollUnsafe() !== undefined
              ? Effect.void
              : Fiber.interrupt(current).pipe(
                  Effect.andThen(
                    Queue.offer(events, { payload: { _tag: "TurnCompleted", stopReason: "interrupted" } }),
                  ),
                  Effect.asVoid,
                ),
          ),
          setModel: (model: string) => switchTo({ model }),
          setEffort: (effort: ReasoningEffort) => switchTo({ effort }),
          ...(manifest.switching.speed === true
            ? { setSpeed: (speed: ModelSpeed) => switchTo({ speed }) }
            : {}),
          ...(compacted === undefined
            ? {}
            : {
                compact:
                  compacted === "fail"
                    ? Effect.fail(
                        new HarnessFailure({ provider, message: "Nothing to compact.", cause: null }),
                      )
                    : Effect.sync(() => void compactions.count++).pipe(
                        Effect.andThen(
                          Effect.forkDetach(
                            Effect.sleep(options.turnDuration ?? 0).pipe(
                              Effect.andThen(
                                Queue.offerAll(events, [
                                  { payload: { _tag: "ContextCompacted", ...compacted } },
                                  { payload: { _tag: "TurnCompleted", stopReason: "completed" } },
                                ]),
                              ),
                              Effect.asVoid,
                            ),
                          ),
                        ),
                        Effect.tap((fiber) => Effect.sync(() => void (current = fiber))),
                        Effect.asVoid,
                      ),
              }),
        };
      }),
  };
  return { adapter, sessions, completions, forks, running, compactions };
};
