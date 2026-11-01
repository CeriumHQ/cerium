import {
  HarnessFailure,
  HarnessUnavailable,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { EventPayload, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Duration, Effect, Exit, Option, Queue, Schema, Stream } from "effect";
import { resolve } from "node:path";

import {
  AcpRequestError,
  AUTH_REQUIRED,
  connect,
  METHOD_NOT_FOUND,
  type AcpCommand,
  type AcpConnection,
  type Params,
  type SessionListener,
} from "./connection.ts";
import { currentModel, effortOption, effortValue, modelOption } from "./models.ts";
import { grantKey, outcomeFor, toAcpMcpServer, verdictFor, type PermissionOutcome } from "./policy.ts";
import {
  capabilitiesOf,
  choicesOf,
  ConfigOption,
  currentChoice,
  PermissionRequest,
  PromptResult,
  SessionNotification,
  SessionSetup,
  type Initialized,
  type PermissionOption,
} from "./schema.ts";
import {
  AcpTranslator,
  type CompactionCounts,
  type ToolCallState,
  type ToolView,
  type TurnEnd,
  type TurnUsage,
} from "./translate.ts";

// One Cerium agent on an ACP agent: its own process, one session in it, turns one at a time.

/** What an ACP harness adds to the protocol: its settings, names and extensions. */
export interface AcpHarness {
  readonly provider: ProviderId;
  /** The harness as the user knows it, for messages. */
  readonly label: string;
  /** The harness's own sign-in command, for when it is signed out. */
  readonly loginCommand?: string;
  /**
   * `session/new`, `session/load` and `session/resume` parameters beside the folder and MCP servers:
   * the agent's own `_meta`, a system prompt.
   */
  readonly sessionParams?: (options: SessionOptions) => Readonly<Record<string, unknown>>;
  /** Enforces vendor settings before the first prompt, including after a cold resume. */
  readonly prepare?: (
    connection: AcpConnection,
    sessionId: string,
    options: SessionOptions,
    setup: SessionSetup,
  ) => Effect.Effect<void, AcpRequestError | HarnessFailure>;
  /**
   * Reads a notification for the session's readiness, where the agent connects MCP servers after
   * answering its setup: `true` once the session is ready for its first prompt, or the name of an MCP
   * server that has finished connecting, ready or not. The first prompt waits for every server Cerium
   * passed, so its turn sees their tools, and never for the user's own.
   */
  readonly ready?: (method: string, params: Params) => boolean | string | undefined;
  /** Names tool calls; `defaultToolView` by default. */
  readonly view?: (call: ToolCallState) => ToolView;
  /** What a finished call shows as its result; `outputOf` by default. */
  readonly output?: (call: ToolCallState) => unknown;
  /** Whether the agent marks a call as only reading, where ACP's kind doesn't say. */
  readonly readsOnly?: (call: ToolCallState) => boolean | undefined;
  /** Vendor interactions carried as permissions must never be auto-answered as tool approvals. */
  readonly cancelPermission?: (request: PermissionRequest) => boolean;
  /** A turn's usage and context from the prompt's answer; ACP's `usage` by default. */
  readonly usage?: (result: PromptResult, session: TurnContext) => TurnTotals;
  /** What an error answer to a prompt stands for; `errorEvent` by default. */
  readonly errorEvent?: (error: AcpRequestError) => EventPayload;
  /** The agent's own notifications about the session, as events. */
  readonly notification?: (method: string, params: Params) => ReadonlyArray<AdapterEvent>;
  /** A compaction the agent reports in a notification of its own, where ACP's update doesn't say. */
  readonly compaction?: (method: string, params: Params) => CompactionCounts | undefined;
  /**
   * Compacts the session's conversation, resolving once it has, with the counts it reports. Present
   * when the agent can.
   */
  readonly compact?: (
    connection: AcpConnection,
    sessionId: string,
  ) => Effect.Effect<CompactionCounts, AcpRequestError | HarnessFailure>;
  /** Where the adapter finds its running sessions again, for requests about one of them. */
  readonly live?: LiveSessions;
}

/** What a turn's usage is read against. */
export interface TurnContext {
  readonly initialized: Initialized;
  /** The session's model when the turn ended. */
  readonly model: string;
}

export interface TurnTotals {
  readonly usage?: TurnUsage;
  readonly context?: { readonly tokens: number; readonly window?: number };
}

/** The sessions an adapter runs right now, by the agent's session id, each with its connection. */
export class LiveSessions {
  readonly #sessions = new Map<string, AcpConnection>();

  get(sessionId: string): AcpConnection | undefined {
    return this.#sessions.get(sessionId);
  }

  /** Holds `sessionId` as running on `connection` until the scope closes. */
  hold(sessionId: string, connection: AcpConnection) {
    return Effect.acquireRelease(
      Effect.sync(() => void this.#sessions.set(sessionId, connection)),
      () =>
        Effect.sync(() => {
          if (this.#sessions.get(sessionId) === connection) this.#sessions.delete(sessionId);
        }),
    );
  }
}

const decodeNotification = Schema.decodeUnknownOption(SessionNotification);
const decodePermission = Schema.decodeUnknownOption(PermissionRequest);
const decodePrompt = Schema.decodeUnknownEffect(PromptResult);
const decodeSetup = Schema.decodeUnknownEffect(SessionSetup);
const decodeOptions = Schema.decodeUnknownOption(
  Schema.Struct({ configOptions: Schema.Array(Schema.Unknown) }),
);
const decodeOption = Schema.decodeUnknownOption(ConfigOption);

/**
 * How long a new session may take to say it's ready. Past it the turn starts anyway: an agent that
 * finds its tools as it goes only misses them from the start.
 */
const READY_TIMEOUT = Duration.seconds(15);
/** How long closing waits for a turn to stop and the session to close. */
const STOP_GRACE = Duration.seconds(5);

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;
const QUOTA =
  /quota|usage limit|credits? (?:exhausted|ran out)|out of credits|limit (?:reached|exceeded)|insufficient/i;

/** What an agent's error answer stands for, read from ACP's codes and the agent's words. */
export const errorEvent =
  (provider: ProviderId, loginCommand?: string) =>
  (error: AcpRequestError): EventPayload => {
    if (
      error.code === AUTH_REQUIRED ||
      /sign(?:ed)? ?in|log(?:ged)? ?in|unauthori[sz]ed|authenticat/i.test(error.message)
    ) {
      return {
        _tag: "AuthRequired",
        provider,
        reason: error.message,
        ...(loginCommand === undefined ? {} : { loginCommand }),
      };
    }
    if (QUOTA.test(error.message)) return { _tag: "LimitReached", provider, message: error.message };
    if (RATE_LIMIT.test(error.message)) {
      return { _tag: "AgentError", kind: "rateLimit", message: error.message, retryable: true };
    }
    return { _tag: "AgentError", kind: "unknown", message: error.message, retryable: false };
  };

/** ACP's usage for a turn: its input counts cache reads, which Cerium counts apart. */
export const standardUsage = (result: PromptResult): TurnTotals => {
  const usage = result.usage;
  if (usage === undefined || usage === null) return {};
  const cached = usage.cachedReadTokens ?? 0;
  return {
    usage: {
      inputTokens: Math.max(0, usage.inputTokens - cached),
      outputTokens: usage.outputTokens,
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    },
  };
};

const stopReasonOf = (reason: string, interrupted: boolean): TurnEnd["stopReason"] => {
  switch (reason) {
    case "max_turn_requests":
      return "maxTurns";
    case "cancelled":
      // An agent also cancels its turn when a permission is refused; only Cerium's own stop interrupts.
      return interrupted ? "interrupted" : "completed";
    default:
      return "completed";
  }
};

/**
 * A turn that opens with a skill the user picked (`$name`) runs it as ACP runs a command: `/name` at
 * the start of the prompt, where the agent offers one by that name.
 */
export const withCommand = (text: string, extras: TurnExtras | undefined, offered: ReadonlySet<string>) => {
  const opening = /^(\s*)\$([\w:.-]+)/.exec(text);
  if (opening === null) return text;
  const [whole, space = "", name = ""] = opening;
  if (!offered.has(name) || !(extras?.skills ?? []).some((skill) => skill.name === name)) return text;
  return `${space}/${name}${text.slice(whole.length)}`;
};

type Turn = { readonly text: string; readonly extras?: TurnExtras } | { readonly compact: true };

interface Ask {
  readonly outcome: Deferred.Deferred<PermissionOutcome>;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly grant: string;
}

/** Why a session can't start while the harness is signed out, with its own command to sign in. */
export const signedOut = (harness: Pick<AcpHarness, "provider" | "label" | "loginCommand">) =>
  new HarnessUnavailable({
    provider: harness.provider,
    reason: "loggedOut",
    message:
      harness.loginCommand === undefined
        ? `${harness.label} is signed out.`
        : `${harness.label} is signed out. Run \`${harness.loginCommand}\`.`,
  });

/**
 * Starts (or resumes) one session on its own agent process. Cerium's MCP servers are the session's,
 * the access mode answers what the agent asks permission for, and turns run one at a time in `send`
 * order, each ending in exactly one `TurnCompleted`. The session lives until the scope closes.
 * `events` is single-consumer.
 */
export const startAcpSession = Effect.fn("Acp.startSession")(function* (
  harness: AcpHarness,
  command: AcpCommand,
  options: SessionOptions,
) {
  const failure = (message: string) => (cause: unknown) =>
    new HarnessFailure({ provider: harness.provider, message, cause });
  const cwd = resolve(options.cwd);
  const connection = yield* connect({ ...command, cwd: command.cwd ?? cwd });
  const capabilities = capabilitiesOf(connection.initialized);
  const trusted = options.trustedMcpServers ?? [];

  const events = yield* Queue.unbounded<AdapterEvent, HarnessFailure | Cause.Done>();
  const emit = (list: ReadonlyArray<AdapterEvent>) => Queue.offerAllUnsafe(events, list);
  const translator = new AcpTranslator({
    provider: harness.provider,
    ...(harness.view === undefined ? {} : { view: harness.view }),
    ...(harness.output === undefined ? {} : { output: harness.output }),
  });

  let sessionId = options.resume ?? "";
  let configOptions: ReadonlyArray<ConfigOption> = [];
  /** The slash commands the agent offers, its skills among them. */
  let commands = new Set<string>();
  /** History `session/load` replays, which the transcript already holds. */
  let replaying = false;
  let closing = false;
  const ready = yield* Deferred.make<void>();
  /** Cerium's MCP servers still connecting. */
  const connecting = new Set(Object.keys(options.mcpServers));
  if (harness.ready === undefined || connecting.size === 0) yield* Deferred.succeed(ready, undefined);

  /** Sends not yet answered by their `TurnCompleted`, including ones waiting to start. */
  let pending = 0;
  let inFlight = false;
  /** An interrupt for the turn in flight, or for one that hasn't started yet. */
  let interruptRequested = false;
  const asks = new Map<string, Ask>();
  const grants = new Set<string>();

  const askPermission = (params: Params) =>
    Effect.gen(function* () {
      const request = Option.getOrUndefined(decodePermission(params));
      if (request === undefined) {
        return yield* new AcpRequestError({
          method: "session/request_permission",
          code: -32602,
          message: "Cerium could not read the permission request",
        });
      }
      if (replaying || interruptRequested) return { outcome: { outcome: "cancelled" } };
      if (harness.cancelPermission?.(request) === true) return { outcome: { outcome: "cancelled" } };
      const call = translator.track(request.toolCall);
      const view = translator.view(call);
      const input = view.input as Readonly<Record<string, unknown>> | undefined;
      const command = typeof input?.["command"] === "string" ? input["command"] : undefined;
      const grant = grantKey(view.name, call.kind, command);
      const readOnly = harness.readsOnly?.(call);
      const verdict = verdictFor(
        options.access,
        {
          toolName: view.name,
          grant,
          ...(call.kind === undefined ? {} : { kind: call.kind }),
          ...(readOnly === undefined ? {} : { readOnly }),
        },
        trusted,
        grants,
      );
      if (verdict._tag === "allow") return { outcome: outcomeFor(request.options, true) };
      if (verdict._tag === "deny") {
        translator.refused(call.id);
        return { outcome: outcomeFor(request.options, false) };
      }
      const requestId = translator.newId();
      const outcome = yield* Deferred.make<PermissionOutcome>();
      asks.set(requestId, { outcome, options: request.options, grant });
      emit(translator.permission(requestId, request));
      return { outcome: yield* Deferred.await(outcome) };
    });

  /** Settles every request still waiting on the user, as ACP asks of a client whose turn stops. */
  const cancelAsks = Effect.gen(function* () {
    for (const [requestId, ask] of asks) {
      emit(translator.resolved(requestId, "deny", "once"));
      yield* Deferred.succeed(ask.outcome, { outcome: "cancelled" });
    }
    asks.clear();
  });

  const listener: SessionListener = {
    notification: (method, params) =>
      Effect.gen(function* () {
        if (method === "session/update") {
          const notification = Option.getOrUndefined(decodeNotification(params));
          if (notification === undefined) return;
          const { update } = notification;
          if (update.sessionUpdate === "config_option_update") configOptions = update.configOptions;
          if (update.sessionUpdate === "available_commands_update") {
            commands = new Set(update.availableCommands.map((command) => command.name));
          }
          if (!replaying) emit(translator.update(update, params));
          return;
        }
        const settled = harness.ready?.(method, params);
        if (typeof settled === "string") connecting.delete(settled);
        if (settled === true || (settled !== undefined && connecting.size === 0)) {
          yield* Deferred.succeed(ready, undefined);
        }
        if (replaying) return;
        if (harness.notification !== undefined) emit(harness.notification(method, params));
        const compaction = harness.compaction?.(method, params);
        if (compaction !== undefined) emit(translator.compactionReported(compaction, params));
      }),
    request: (method, params) =>
      method === "session/request_permission"
        ? askPermission(params)
        : Effect.fail(
            new AcpRequestError({
              method,
              code: METHOD_NOT_FOUND,
              message: `Cerium does not serve ${method}`,
            }),
          ),
  };

  const mcpServers = Object.entries(options.mcpServers).map(([name, spec]) =>
    toAcpMcpServer(name, spec, capabilities.httpMcp),
  );
  const params = { cwd, mcpServers, ...harness.sessionParams?.(options) };
  /** A session request, with a refusal read as a sign-out where the agent says so. */
  const setUp = (method: string, body: unknown) =>
    connection.request(method, body).pipe(
      Effect.mapError((error) =>
        error._tag === "HarnessFailure"
          ? error
          : error.code === AUTH_REQUIRED
            ? signedOut(harness)
            : failure(`${harness.label} could not start the session: ${error.message}`)(error),
      ),
      Effect.flatMap((answer) =>
        decodeSetup(answer).pipe(
          Effect.mapError(failure(`${harness.label} answered ${method} unexpectedly`)),
        ),
      ),
    );

  const resume = options.resume;
  const setup = yield* Effect.gen(function* () {
    if (resume === undefined) {
      const created = yield* setUp("session/new", params);
      if (created.sessionId === undefined) {
        return yield* failure(`${harness.label} started a session without an id`)(created);
      }
      sessionId = created.sessionId;
      yield* connection.attach(sessionId, listener);
      return created;
    }
    if (!capabilities.resume && !capabilities.load) {
      return yield* failure(`${harness.label} cannot resume sessions`)(connection.initialized);
    }
    yield* connection.attach(resume, listener);
    // `session/resume` picks the conversation up without replaying it; `session/load` replays it.
    const method = capabilities.resume ? "session/resume" : "session/load";
    replaying = method === "session/load";
    return yield* setUp(method, { ...params, sessionId: resume }).pipe(
      Effect.ensuring(Effect.sync(() => (replaying = false))),
    );
  });
  configOptions = setup.configOptions ?? configOptions;
  if (harness.prepare !== undefined) {
    yield* harness
      .prepare(connection, sessionId, options, setup)
      .pipe(Effect.mapError(failure(`${harness.label} could not apply the session's access mode`)));
  }
  if (harness.live !== undefined) yield* harness.live.hold(sessionId, connection);

  const applyOptions = (answer: unknown) => {
    const decoded = Option.getOrUndefined(decodeOptions(answer));
    if (decoded === undefined) return;
    configOptions = decoded.configOptions.flatMap((each) => Option.toArray(decodeOption(each)));
  };
  const setOption = (option: ConfigOption, value: string) =>
    connection
      .request("session/set_config_option", { sessionId, configId: option.id, value })
      .pipe(Effect.tap((answer) => Effect.sync(() => applyOptions(answer))));

  const applyModel = (next: string) =>
    Effect.gen(function* () {
      const option = modelOption(configOptions);
      if (option !== undefined) {
        if (currentChoice(option) === next) return;
        if (!choicesOf(option).some((choice) => choice.value === next)) {
          return yield* failure(`"${next}" is not one of ${harness.label}'s models`)(choicesOf(option));
        }
        return yield* setOption(option, next).pipe(
          Effect.mapError(failure(`${harness.label} refused the model`)),
        );
      }
      if (setup.models !== undefined && setup.models !== null) {
        if (setup.models.currentModelId === next) return;
        yield* connection
          .request("session/set_model", { sessionId, modelId: next })
          .pipe(Effect.mapError(failure(`${harness.label} refused the model`)));
        return;
      }
      return yield* failure(`${harness.label} offers no model choice`)(connection.initialized);
    });

  const applyEffort = (next: ReasoningEffort) =>
    Effect.gen(function* () {
      const option = effortOption(configOptions);
      if (option === undefined) return;
      const value = effortValue(choicesOf(option), next);
      if (value === undefined || currentChoice(option) === value) return;
      yield* setOption(option, value).pipe(Effect.mapError(failure(`${harness.label} refused the effort`)));
    });

  let model = options.model;
  let effort = options.effort;
  if (model !== "" && model !== currentModel(configOptions, setup.models)) yield* applyModel(model);
  if (effort !== undefined) yield* applyEffort(effort);
  // Cerium's MCP servers may still be connecting; the first turn waits for them.
  yield* Deferred.await(ready).pipe(Effect.timeout(READY_TIMEOUT), Effect.ignore);
  if (model === "") model = currentModel(configOptions, setup.models) ?? "default";
  emit(translator.opened(sessionId, model, effort));

  const promptBlocks = (text: string, extras?: TurnExtras) => [
    { type: "text", text: withCommand(text, extras, commands) },
    ...(capabilities.images
      ? (extras?.images ?? []).map((image) => ({
          type: "image",
          data: image.data,
          mimeType: image.mediaType,
        }))
      : []),
  ];

  const toError = (cause: unknown): TurnEnd => {
    if (cause instanceof AcpRequestError) {
      return {
        stopReason: "error",
        error: (harness.errorEvent ?? errorEvent(harness.provider, harness.loginCommand))(cause),
      };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stopReason: "error", error: { _tag: "AgentError", kind: "crash", message, retryable: false } };
  };

  const promptTurn = (text: string, extras?: TurnExtras) =>
    connection.request("session/prompt", { sessionId, prompt: promptBlocks(text, extras) }).pipe(
      Effect.flatMap(decodePrompt),
      Effect.map((result): TurnEnd => {
        const totals = (harness.usage ?? standardUsage)(result, {
          initialized: connection.initialized,
          model,
        });
        return {
          stopReason: stopReasonOf(result.stopReason, interruptRequested),
          ...(totals.usage === undefined ? {} : { usage: totals.usage }),
          ...(totals.context === undefined ? {} : { context: totals.context }),
        };
      }),
    );

  const compactTurn = (compact: NonNullable<AcpHarness["compact"]>): Effect.Effect<TurnEnd, unknown> =>
    Effect.gen(function* () {
      translator.compacting();
      const done = yield* compact(connection, sessionId);
      emit(translator.compacted(done));
      return { stopReason: "completed" } satisfies TurnEnd;
    });

  const runTurn = (turn: Turn) =>
    Effect.gen(function* () {
      if (interruptRequested) {
        interruptRequested = false;
        pending--;
        emit(translator.endTurn({ stopReason: "interrupted" }));
        return;
      }
      inFlight = true;
      const work: Effect.Effect<TurnEnd, unknown> =
        "compact" in turn
          ? harness.compact === undefined
            ? Effect.fail(failure(`${harness.label} cannot compact`)(undefined))
            : compactTurn(harness.compact)
          : promptTurn(turn.text, turn.extras);
      const exit = yield* Effect.exit(work);
      inFlight = false;
      yield* cancelAsks;
      emit(translator.endTurn(Exit.isSuccess(exit) ? exit.value : toError(Cause.squash(exit.cause))));
      interruptRequested = false;
      pending--;
    });

  const input = yield* Queue.unbounded<Turn>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(input).pipe(Effect.flatMap(runTurn))));

  // An agent that exits ends the session with the reason it gave.
  yield* connection.exited.pipe(
    Effect.andThen(
      Effect.suspend(() =>
        closing ? Effect.void : Queue.fail(events, failure(`${harness.label} stopped`)(connection.stderr())),
      ),
    ),
    Effect.forkScoped,
  );

  const cancel = Effect.suspend(() =>
    cancelAsks.pipe(Effect.andThen(connection.notify("session/cancel", { sessionId }))),
  );

  // Registered after the fibers above, so it runs while they still are.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      if (inFlight) yield* cancel;
      if (capabilities.close) {
        yield* connection
          .request("session/close", { sessionId })
          .pipe(Effect.timeout(STOP_GRACE), Effect.ignore);
      }
      yield* Queue.end(events);
    }),
  );

  const respondToPermission = (requestId: string, decision: PermissionDecision) =>
    Effect.gen(function* () {
      const ask = asks.get(requestId);
      if (ask === undefined) return;
      asks.delete(requestId);
      emit(translator.resolved(requestId, decision.decision, decision.scope));
      const allow = decision.decision === "allow";
      if (allow && decision.scope === "session") grants.add(ask.grant);
      yield* Deferred.succeed(ask.outcome, outcomeFor(ask.options, allow));
    });

  const enqueue = (turn: Turn) =>
    Effect.sync(() => pending++).pipe(Effect.andThen(Queue.offer(input, turn)), Effect.asVoid);

  const session: AgentSession = {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      extras?.images?.length && !capabilities.images
        ? Effect.fail(failure(`${harness.label} did not negotiate image input`)(undefined))
        : enqueue({ text, ...(extras === undefined ? {} : { extras }) }),
    respondToPermission,
    interrupt: Effect.suspend(() => {
      if (pending > 0) interruptRequested = true;
      return inFlight ? cancel : Effect.void;
    }),
    setModel: (next) =>
      applyModel(next).pipe(
        Effect.tap(() => Effect.sync(() => (model = next))),
        // A model's efforts may differ: the one asked for is set again on it.
        Effect.andThen(effort === undefined ? Effect.void : applyEffort(effort)),
      ),
    setEffort: (next) => applyEffort(next).pipe(Effect.tap(() => Effect.sync(() => (effort = next)))),
    ...(harness.compact === undefined ? {} : { compact: enqueue({ compact: true }) }),
  };
  return session;
});
