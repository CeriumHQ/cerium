import type {
  AdapterEvent,
  HarnessFailure,
  HarnessUnavailable,
  PermissionDecision,
  TurnExtras,
} from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";
import { Cause, Effect, Fiber, Queue, Scope, Semaphore, Stream, type Duration } from "effect";
import { randomUUID } from "node:crypto";

import type { AcpConnection, RequestId } from "./connection.ts";
import { needsLogin, type AcpError } from "./errors.ts";
import { loginRequired } from "./harness.ts";
import { record, string, type JsonRecord } from "./json.ts";
import {
  cancelledOutcome,
  configOption,
  onceOptions,
  promptBlocks,
  readConfigOptions,
  refusal,
  selectedOutcome,
  toStopReason,
  type ConfigOption,
  type OnceOptions,
  type StopReason,
} from "./protocol.ts";
import type { AcpTranslator } from "./translate.ts";

/**
 * Opens the session with `session/new`, `session/load` or `session/resume`. A signed-out CLI fails
 * with the harness's `loggedOut`; any other refusal names the method.
 */
export const openSession = (acp: AcpConnection, method: string, params: JsonRecord) =>
  acp
    .query(method, params)
    .pipe(
      Effect.mapError((error): HarnessUnavailable | HarnessFailure =>
        needsLogin(error) ? loginRequired(acp.harness) : acp.refused(method)(error),
      ),
    );

/** How the user answered, as an approval's `answer` sees it. */
export interface Verdict {
  readonly allow: boolean;
  /** The turn was interrupted or the session closed before the user answered. */
  readonly cancelled: boolean;
  readonly message?: string;
}

/** What answering an approval does: whether the call may run, and the reply to the agent's request. */
export interface Answer {
  readonly allowed: boolean;
  readonly result: unknown;
}

export interface ApprovalRequest {
  /** The agent's request the answer replies to. */
  readonly id: RequestId;
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
  readonly answer: (verdict: Verdict) => Answer;
}

/** Answers with a permission request's once-only options; `allow` without one is a refusal. */
export const answerOnce =
  (options: OnceOptions) =>
  ({ allow, cancelled }: Verdict): Answer => {
    const optionId = cancelled ? undefined : allow ? options.allow : options.deny;
    return {
      allowed: allow && optionId !== undefined,
      result: optionId === undefined ? cancelledOutcome : selectedOutcome(optionId),
    };
  };

/** The model and prompt one turn runs with. */
export interface TurnPlan {
  /** The model the turn's usage is reported for. */
  readonly model: string;
  /** Replaces the text the turn was sent with, such as to open it with instructions. */
  readonly text?: string;
  /** `session/prompt`'s `_meta`. */
  readonly meta?: JsonRecord;
}

export type RequestHandler = (id: RequestId, params: JsonRecord, session: AcpSession) => Effect.Effect<void>;

export interface AcpSessionOptions {
  readonly acp: AcpConnection;
  readonly sessionId: string;
  readonly translator: AcpTranslator;
  /**
   * Handles `session/request_permission`. By default the user is asked about any tool the agent
   * offers a once-only grant for, and every other request is refused.
   */
  readonly permission?: RequestHandler;
  /** Handlers for the agent's other requests, by method. Requests without one are refused. */
  readonly requests?: Readonly<Record<string, RequestHandler>>;
  /** Provider notifications outside the standard `session/update` stream. */
  readonly notification?: (method: string, params: JsonRecord, session: AcpSession) => Effect.Effect<void>;
  /** Approvals the user hasn't answered by then are denied, before the agent stops waiting. */
  readonly approvalTimeout?: Duration.Input;
  /** Sends `session/close` when the scope closes between turns. Default true. */
  readonly closeOnExit?: boolean;
  /**
   * Reported as an error when the agent exits between turns. Without it the stream just ends, and
   * the orchestrator reopens the session for the next turn.
   */
  readonly idleExitMessage?: string;
  /** Runs once each turn has ended, after its events. */
  readonly onTurnEnd?: () => void;
}

/** The parts of a session the adapter's handlers and own methods build on. */
export interface AcpSession {
  readonly acp: AcpConnection;
  readonly sessionId: string;
  readonly translator: AcpTranslator;
  readonly events: Stream.Stream<AdapterEvent, HarnessFailure>;
  readonly emit: (payload: EventPayload) => Effect.Effect<void>;
  /** Whether a turn is running and hasn't been interrupted, so its requests may still be granted. */
  readonly accepting: (params: JsonRecord) => boolean;
  readonly isActive: () => boolean;
  readonly isCancelling: () => boolean;
  /** Asks the user, through `PermissionRequested`, and replies to the agent when they answer. */
  readonly ask: (request: ApprovalRequest) => Effect.Effect<void>;
  readonly respondToPermission: (requestId: string, decision: PermissionDecision) => Effect.Effect<void>;
  /** Runs a session change between turns, one at a time; it fails while a turn runs. */
  readonly whenIdle: <E>(operation: Effect.Effect<void, E>) => Effect.Effect<void, E | HarnessFailure>;
  /** Starts a turn, between turns; the turn reports its events and ends with `TurnCompleted`. */
  readonly send: (
    text: string,
    extras: TurnExtras | undefined,
    plan: () => Effect.Effect<TurnPlan, HarnessFailure>,
  ) => Effect.Effect<void, HarnessFailure>;
  /** Runs a native compaction RPC between turns and reports it on the same event stream. */
  readonly compact: (
    method: string,
    params: JsonRecord,
    model: () => string,
  ) => Effect.Effect<void, HarnessFailure>;
  readonly interrupt: Effect.Effect<void>;
}

/**
 * The turn lifecycle every ACP harness shares: one `session/prompt` at a time, `session/update`s
 * translated while it runs, approvals that cover one call and lapse with the turn, `session/cancel`
 * to interrupt, and the stream's end once the agent has gone.
 */
export const makeAcpSession = Effect.fn("Acp.session")(function* (options: AcpSessionOptions) {
  const { acp, sessionId, translator } = options;
  const { label, provider } = acp.harness;
  const scope = yield* Scope.Scope;
  const target = { sessionId };
  const queue = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const serial = yield* Semaphore.make(1);
  let active = false;
  let cancelling = false;
  const approvals = new Map<string, { readonly request: ApprovalRequest; timer?: Fiber.Fiber<void> }>();

  const emit = (payload: EventPayload) => Queue.offer(queue, { payload }).pipe(Effect.asVoid);
  const emitAll = (payloads: ReadonlyArray<EventPayload>) =>
    Effect.forEach(payloads, emit, { discard: true });

  const settle = (requestId: string, decision: PermissionDecision, cancelled: boolean) =>
    Effect.gen(function* () {
      const approval = approvals.get(requestId);
      if (approval === undefined) return;
      approvals.delete(requestId);
      if (approval.timer !== undefined) yield* Fiber.interrupt(approval.timer);
      const { allowed, result } = approval.request.answer({
        allow: decision.decision === "allow" && !cancelled,
        cancelled,
        ...(decision.message === undefined ? {} : { message: decision.message }),
      });
      // Agents' "always" grants can outlive the conversation. Cerium's approval is one call at most.
      yield* emit({
        _tag: "PermissionResolved",
        requestId,
        decision: allowed ? "allow" : "deny",
        scope: "once",
      });
      yield* acp.respond(approval.request.id, result);
    });

  const cancelApprovals = Effect.suspend(() =>
    Effect.forEach([...approvals.keys()], (id) => settle(id, { decision: "deny", scope: "once" }, true), {
      discard: true,
    }),
  );

  const ask = (request: ApprovalRequest) =>
    Effect.gen(function* () {
      const requestId = randomUUID();
      const approval: { request: ApprovalRequest; timer?: Fiber.Fiber<void> } = { request };
      approvals.set(requestId, approval);
      if (options.approvalTimeout !== undefined) {
        approval.timer = yield* Effect.sleep(options.approvalTimeout).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              // This fiber settles it, so settling mustn't interrupt it.
              delete approval.timer;
              return settle(requestId, { decision: "deny", scope: "once" }, cancelling);
            }),
          ),
          Effect.forkIn(scope),
        );
      }
      yield* emit({
        _tag: "PermissionRequested",
        requestId,
        toolName: request.toolName,
        summary: request.summary,
        input: request.input,
      });
    });

  const whenIdle = <E>(operation: Effect.Effect<void, E>) =>
    serial.withPermit(
      Effect.suspend((): Effect.Effect<void, E | HarnessFailure> =>
        acp.isClosed()
          ? Effect.fail(acp.failure(`The ${label} ACP process exited`))
          : active
            ? Effect.fail(acp.failure(`A ${label} turn is still running`))
            : operation,
      ),
    );

  const accepting = (params: JsonRecord) => params["sessionId"] === sessionId && active && !cancelling;

  const start = (method: string, params: JsonRecord, model: string, compact: boolean) =>
    Effect.gen(function* () {
      active = true;
      cancelling = false;
      const { awaitResponse } = yield* acp.beginRequest(method, params);
      yield* run(method, awaitResponse, model, compact).pipe(Effect.interruptible, Effect.forkIn(scope));
    }).pipe(Effect.uninterruptible);

  const session: AcpSession = {
    acp,
    sessionId,
    translator,
    events: Stream.fromQueue(queue),
    emit,
    accepting,
    isActive: () => active,
    isCancelling: () => cancelling,
    ask,
    respondToPermission: (requestId, decision) =>
      Effect.suspend(() => settle(requestId, decision, cancelling)),
    whenIdle,
    send: (text, extras, plan) =>
      whenIdle(
        Effect.gen(function* () {
          if (extras?.images?.length && !acp.agent.images) {
            return yield* acp.failure(`This ${label} CLI does not accept images`);
          }
          const turn = yield* plan();
          yield* start(
            "session/prompt",
            {
              ...target,
              prompt: promptBlocks(turn.text ?? text, extras?.images),
              ...(turn.meta === undefined ? {} : { _meta: turn.meta }),
            },
            turn.model,
            false,
          );
        }).pipe(Effect.uninterruptible),
      ),
    compact: (method, params, model) => whenIdle(Effect.suspend(() => start(method, params, model(), true))),
    interrupt: Effect.suspend(() => {
      if (!active || cancelling) return Effect.void;
      cancelling = true;
      return acp.notify("session/cancel", target).pipe(Effect.andThen(cancelApprovals));
    }),
  };

  const finish = (answer: unknown, model: string, stopReason: StopReason) =>
    Effect.gen(function* () {
      yield* cancelApprovals;
      yield* emitAll(translator.finish(answer, model));
      yield* Effect.sync(() => {
        active = false;
        cancelling = false;
        Queue.offerUnsafe(queue, { payload: { _tag: "TurnCompleted", stopReason } });
        options.onTurnEnd?.();
      });
      if (acp.isClosed()) yield* Queue.end(queue);
    });

  const agentError = (message: string) =>
    emit({ _tag: "AgentError", kind: "unknown", message, retryable: false });

  const run = (
    method: string,
    awaitResponse: Effect.Effect<unknown, AcpError | HarnessFailure>,
    model: string,
    compact: boolean,
  ) =>
    awaitResponse.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            if (needsLogin(error)) {
              yield* emit({
                _tag: "AuthRequired",
                provider,
                reason: acp.harness.signedOut,
                loginCommand: acp.harness.loginCommand,
              });
            } else if (!cancelling) {
              yield* agentError(acp.refused(method)(error).message);
            }
            yield* finish(undefined, model, cancelling ? "interrupted" : "error");
          }),
        onSuccess: (answer) =>
          Effect.gen(function* () {
            const reason = cancelling ? "interrupted" : compact ? "completed" : toStopReason(answer);
            if (compact && reason === "completed")
              yield* emit({ _tag: "ContextCompacted", trigger: "manual" });
            if (reason === "error") yield* agentError(`${label} stopped the turn without completing it`);
            yield* finish(answer, model, reason);
          }),
      }),
    );

  const permission = options.permission ?? askOnceOnly;
  acp.onMessage(({ method, params: raw, id }) =>
    Effect.suspend(() => {
      const params = record(raw) ?? {};
      if (id !== undefined) {
        const handler = method === "session/request_permission" ? permission : options.requests?.[method];
        return handler === undefined ? acp.reject(id) : handler(id, params, session);
      }
      if (method !== "session/update") return options.notification?.(method, params, session) ?? Effect.void;
      if (params["sessionId"] !== sessionId || !active) return Effect.void;
      return emitAll(translator.update(params["update"]));
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      cancelling = true;
      yield* cancelApprovals;
      yield* Queue.end(queue);
      if (options.closeOnExit !== false && !active) {
        yield* acp.request("session/close", target).pipe(Effect.timeout("2 seconds"), Effect.ignore);
      }
    }),
  );

  // If the agent exits during a prompt, the prompt reports the error and finishes the turn. An idle
  // exit ends the stream so the orchestrator can reopen the provider session later.
  yield* acp.exited.pipe(
    Effect.flatMap(() =>
      active
        ? Effect.void
        : (options.idleExitMessage === undefined ? Effect.void : agentError(options.idleExitMessage)).pipe(
            Effect.andThen(Queue.end(queue)),
          ),
    ),
    Effect.forkScoped,
  );

  return session;
});

/**
 * The default `session/request_permission` handler: the user decides calls the agent offers a
 * once-only grant for, and every other request is refused.
 */
export const askOnceOnly: RequestHandler = (id, params, session) => {
  const tool = record(params["toolCall"]);
  if (!session.accepting(params) || tool === undefined) return session.acp.respond(id, cancelledOutcome);
  const options = onceOptions(params);
  if (options.allow === undefined) return session.acp.respond(id, refusal(options));
  const toolName = string(tool["name"]) ?? string(tool["kind"]) ?? "Tool";
  return session.ask({
    id,
    toolName,
    summary: string(tool["title"]) ?? toolName,
    input: tool["rawInput"] ?? tool["args"] ?? {},
    answer: answerOnce(options),
  });
};

export interface ConfigState {
  readonly options: () => ReadonlyArray<ConfigOption>;
  readonly current: (id: string) => ConfigOption | undefined;
  /** Switches a select option with `session/set_config_option` and checks that the agent applied it. */
  readonly set: (id: string, value: string) => Effect.Effect<void, HarnessFailure>;
}

export interface ConfigStateOptions {
  readonly acp: AcpConnection;
  readonly sessionId: string;
  readonly initial: ReadonlyArray<ConfigOption>;
  /** Reads the options a change returns. By default every select option that parses. */
  readonly read?: (result: unknown) => Effect.Effect<ReadonlyArray<ConfigOption>, HarnessFailure>;
  /**
   * Refuse values the option doesn't list before asking the agent. Default true; off for agents
   * that report only each option's current value.
   */
  readonly requireOffered?: boolean;
}

/** A session's `configOptions`, kept current as they change. */
export const makeConfigState = ({
  acp,
  sessionId,
  initial,
  read = (result) => Effect.succeed(readConfigOptions(record(result)?.["configOptions"])),
  requireOffered = true,
}: ConfigStateOptions): ConfigState => {
  let config = initial;
  const label = acp.harness.label;
  return {
    options: () => config,
    current: (id) => configOption(config, id),
    set: (id, value) =>
      Effect.gen(function* () {
        const option = configOption(config, id);
        if (requireOffered && !option?.options.some((choice) => choice.value === value)) {
          return yield* acp.failure(`${label} does not offer ${value} for ${id} in this session`);
        }
        if (option?.currentValue === value) return;
        config = yield* acp
          .call("session/set_config_option", { sessionId, configId: id, value })
          .pipe(Effect.flatMap(read));
        if (configOption(config, id)?.currentValue !== value) {
          return yield* acp.failure(`${label} did not apply ${value} for ${id}`);
        }
      }),
  };
};
