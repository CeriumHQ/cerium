import {
  HarnessFailure,
  HarnessUnavailable,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Duration, Effect, Exit, Queue, Stream } from "effect";
import { isAbsolute, relative, resolve } from "node:path";

import { openAcpAgent } from "./agent.ts";
import { AcpError, AcpRequestError, isAuthError, type AcpConnection, type WireFrame } from "./connection.ts";
import type { AcpHarness, LaunchPurpose } from "./harness.ts";
import {
  autoAnswer,
  configOption,
  effortValue,
  grantKey,
  isTrustedTool,
  pickOption,
  toAcpMcpServer,
} from "./policy.ts";
import type {
  AgentCapabilities,
  AvailableCommand,
  ContentBlock,
  LegacyModelState,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionSetup,
} from "./schema.ts";
import { AcpTranslator, type AcpRecord } from "./translate.ts";

/** How long closing waits for a turn in flight to stop. */
const STOP_GRACE = Duration.seconds(5);
/** How long `session/close` and `session/delete` may take when the session ends. */
const CLOSE_GRACE = Duration.seconds(3);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How a session's process differs from an agent's. */
export interface AcpSessionOverrides {
  readonly purpose?: LaunchPurpose;
  /** Deletes the session when it ends (completions, side questions), where the agent can. */
  readonly ephemeral?: boolean;
  /**
   * Copies this session instead of starting or resuming one: up to, not including, its `promptIndex`th
   * prompt when given (the harness's own fork), else whole (ACP's unstable `session/fork` where the
   * harness has no fork of its own).
   */
  readonly forkOf?: { readonly sessionId: string; readonly promptIndex?: number };
  /** Sees every frame and every record (the fixture recorder). */
  readonly record?: (frame: WireFrame) => void;
}

/** A message to send, or a compaction to ask for. */
type Turn = { readonly text: string; readonly extras?: TurnExtras } | { readonly compact: true };

type Verdict = { readonly decision: PermissionDecision } | { readonly cancelled: true };

/** What a session holds of its agent once it is open: the connection and what `initialize` said. */
export interface OpenedSession {
  readonly connection: AcpConnection;
  readonly capabilities: AgentCapabilities;
  readonly sessionId: string;
}

/** The text Cerium's instructions take before a session's first prompt, for agents with no other way. */
export const instructionsPreamble = (instructions: string) =>
  `<cerium-instructions>\n${instructions}\n</cerium-instructions>\n\n`;

/**
 * Starts (or resumes) a session of an ACP agent on a process of its own: per-session MCP servers, access
 * modes and command-line flags stay the session's. Cerium's MCP servers go on `session/new`; the access
 * mode becomes the agent's matching session mode where it has one, and Cerium's answers to its permission
 * requests. Turns run one at a time in `send` order, each ending in exactly one `TurnCompleted`. The
 * session lives until the enclosing scope closes. `events` is single-consumer.
 */
export const startAcpSession = Effect.fn("AcpSession.start")(function* (
  harness: AcpHarness,
  executablePath: string,
  options: SessionOptions,
  overrides: AcpSessionOverrides = {},
) {
  const failure = (message: string) => (cause: unknown) =>
    new HarnessFailure({ provider: harness.provider, message, cause });
  const refused = (what: string) => (error: AcpError) =>
    failure(`${harness.name} refused to ${what}: ${error.message}`)(error);

  const cwd = resolve(options.cwd);
  const injected = Object.keys(options.mcpServers);
  const trusted = options.trustedMcpServers ?? [];
  const agent = yield* openAcpAgent(
    harness,
    executablePath,
    {
      purpose: overrides.purpose ?? "session",
      cwd,
      access: options.access,
      model: options.model,
      effort: options.effort,
      appendSystemPrompt: options.appendSystemPrompt,
      includeUserMcpServers: options.includeUserMcpServers,
      injectedMcpServers: injected,
    },
    overrides.record,
  );
  const { connection, command: launch } = agent;
  if (!agent.signedIn) {
    return yield* new HarnessUnavailable({
      provider: harness.provider,
      reason: "loggedOut",
      message: `${harness.name} is not signed in${harness.loginCommand ? `. Run \`${harness.loginCommand}\`.` : "."}`,
    });
  }
  const sessionMeta = launch.sessionMeta === undefined ? {} : { _meta: { ...launch.sessionMeta } };
  const capabilities = connection.initialized.agentCapabilities ?? {};
  const sessionCapabilities = capabilities.sessionCapabilities ?? {};

  // Cerium's bus is served over HTTP; ACP agents need only take stdio servers.
  const mcpServers: Array<McpServer> = [];
  for (const [name, spec] of Object.entries(options.mcpServers)) {
    if (spec.type === "http" && capabilities.mcpCapabilities?.http !== true) {
      return yield* failure(
        `${harness.name} doesn't take HTTP MCP servers over ACP, so Cerium's tools can't be given to it`,
      )(capabilities);
    }
    mcpServers.push(toAcpMcpServer(name, spec));
  }
  // The user's own servers, for an agent that leaves loading them to its client. Cerium's win a name clash.
  if (options.includeUserMcpServers && launch.userMcpServers !== undefined) {
    for (const server of yield* launch.userMcpServers) {
      if (!mcpServers.some((each) => each.name === server.name)) mcpServers.push(server);
    }
  }

  const events = yield* Queue.unbounded<AdapterEvent, HarnessFailure | Cause.Done>();
  const translator = new AcpTranslator({
    provider: harness.provider,
    ...(harness.loginCommand ? { loginCommand: harness.loginCommand } : {}),
    ...(harness.describeTool
      ? { describeTool: (call, servers) => harness.describeTool!(call, servers) }
      : {}),
    mcpServers: injected,
    usage: harness.usage ?? "turn",
    cwd,
    ...(harness.turnUsage ? { turnUsage: (response) => harness.turnUsage!(response) } : {}),
  });
  const emit = (record: AcpRecord) => Queue.offerAllUnsafe(events, translator.translate(record));

  let sessionId: string | undefined;
  /** Updates are dropped while `session/load` replays history the session already knows. */
  let replaying = false;
  let configOptions: ReadonlyArray<SessionConfigOption> = [];
  let commands: ReadonlyArray<AvailableCommand> = [];
  let closing = false;

  connection.onNotification((method, params) => {
    if (method !== "session/update" || !isRecord(params)) return;
    const notification = params as unknown as SessionNotification;
    if (sessionId !== undefined && notification.sessionId !== sessionId) return;
    if (!isRecord(notification.update)) return;
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      configOptions = update.configOptions;
    }
    if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
      commands = update.availableCommands;
    }
    if (replaying || sessionId === undefined) return;
    emit({ type: "update", update });
  });

  // Permission requests: Cerium's access mode answers what it can, the user the rest.
  const pending = new Map<string, Deferred.Deferred<Verdict>>();
  const grants = new Set<string>();
  let permissions = 0;
  const insideWorkspace = (path: string | undefined) => {
    if (path === undefined) return false;
    const within = relative(cwd, resolve(cwd, path));
    return within === "" || (!within.startsWith("..") && !isAbsolute(within));
  };
  const select = (
    request: RequestPermissionRequest,
    decision: PermissionDecision,
  ): RequestPermissionResponse => {
    const option = pickOption(request.options, decision);
    return option === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: option.optionId } };
  };
  const decide = (request: RequestPermissionRequest) =>
    Effect.gen(function* () {
      const fields = isRecord(request.toolCall) ? request.toolCall : { toolCallId: `call:${permissions}` };
      const call = translator.track(fields);
      const described = translator.describe(call);
      const path =
        isRecord(described.input) && typeof described.input["path"] === "string"
          ? described.input["path"]
          : call.locations[0]?.path;
      if (harness.isWithheld?.(call, described) === true) {
        return select(request, { decision: "deny", scope: "once" });
      }
      const key = grantKey(call, described.toolName, described.input);
      const answer = grants.has(key)
        ? "allow"
        : autoAnswer(options.access, call, {
            trusted: isTrustedTool(described.toolName, trusted),
            insideWorkspace: insideWorkspace(path),
          });
      if (answer !== "ask") return select(request, { decision: answer, scope: "once" });
      const requestId = `${sessionId ?? "acp"}:permission:${++permissions}`;
      const verdict = yield* Deferred.make<Verdict>();
      pending.set(requestId, verdict);
      emit({ type: "permission", requestId, request });
      const given = yield* Deferred.await(verdict).pipe(
        Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      );
      if ("cancelled" in given)
        return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResponse;
      if (given.decision.decision === "allow" && given.decision.scope === "session") grants.add(key);
      return select(request, given.decision);
    });
  connection.onRequest((method, params) => {
    if (method === "session/request_permission" && isRecord(params)) {
      return decide(params as unknown as RequestPermissionRequest);
    }
    // Cerium offers no file system, terminal or elicitation of its own.
    return Effect.fail(new AcpRequestError({ code: -32601, message: `Cerium doesn't serve ${method}` }));
  });
  const cancelPending = Effect.suspend(() =>
    Effect.forEach([...pending.values()], (verdict) => Deferred.succeed(verdict, { cancelled: true }), {
      discard: true,
    }),
  );

  // Open the session.
  const instructions = options.appendSystemPrompt?.trim() ? options.appendSystemPrompt : undefined;
  const systemPrompt =
    instructions !== undefined &&
    sessionCapabilities.systemPrompt !== undefined &&
    sessionCapabilities.systemPrompt !== null
      ? { systemPrompt: { mode: "append", content: [{ type: "text", text: instructions }] } }
      : {};
  /** Instructions that still have to reach the agent, before its first prompt. */
  let preamble =
    instructions !== undefined &&
    !("systemPrompt" in systemPrompt) &&
    harness.instructions === "firstPrompt" &&
    (options.resume === undefined || overrides.forkOf !== undefined)
      ? instructionsPreamble(instructions)
      : undefined;

  const signedOut = (error: AcpError) =>
    isAuthError(error)
      ? new HarnessUnavailable({
          provider: harness.provider,
          reason: "loggedOut",
          message: `${harness.name} is not signed in${harness.loginCommand ? `. Run \`${harness.loginCommand}\`.` : "."}`,
        })
      : undefined;
  const open = <A>(what: string, effect: Effect.Effect<A, AcpError>) =>
    effect.pipe(
      Effect.mapError(
        (error): HarnessFailure | HarnessUnavailable => signedOut(error) ?? refused(what)(error),
      ),
    );

  let setup: SessionSetup;
  // A copy is a session of its own, opened as a resume of the copy's id.
  let resumeId = options.resume;
  if (overrides.forkOf !== undefined) {
    const source = overrides.forkOf;
    if (harness.fork !== undefined) {
      resumeId = yield* harness
        .fork(connection, {
          sessionId: source.sessionId,
          cwd,
          ...(source.promptIndex === undefined ? {} : { promptIndex: source.promptIndex }),
        })
        .pipe(Effect.mapError(refused("copy the session")));
    } else if (
      source.promptIndex !== undefined ||
      sessionCapabilities.fork === undefined ||
      sessionCapabilities.fork === null
    ) {
      return yield* failure(`${harness.name} can't copy a session`)(sessionCapabilities);
    } else {
      const copied = yield* open(
        "copy the session",
        connection.request<SessionSetup>("session/fork", {
          sessionId: source.sessionId,
          cwd,
          mcpServers,
          ...systemPrompt,
          ...sessionMeta,
        }),
      );
      if (typeof copied.sessionId !== "string")
        return yield* failure(`${harness.name} copied no session`)(copied);
      resumeId = copied.sessionId;
    }
  }
  if (resumeId !== undefined) {
    const resume = resumeId;
    if (sessionCapabilities.resume !== undefined && sessionCapabilities.resume !== null) {
      setup = yield* open(
        "resume the session",
        connection.request<SessionSetup>("session/resume", {
          sessionId: resume,
          cwd,
          mcpServers,
          ...systemPrompt,
          ...sessionMeta,
        }),
      );
    } else if (capabilities.loadSession === true) {
      // `session/load` replays the conversation as updates first; the transcript already has it.
      replaying = true;
      sessionId = resume;
      setup = yield* open(
        "load the session",
        connection.request<SessionSetup>("session/load", {
          sessionId: resume,
          cwd,
          mcpServers,
          ...systemPrompt,
          ...sessionMeta,
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => (replaying = false))));
    } else {
      return yield* failure(`${harness.name} can't resume a session`)(capabilities);
    }
    sessionId = resume;
  } else {
    setup = yield* open(
      "start a session",
      connection.request<SessionSetup>("session/new", { cwd, mcpServers, ...systemPrompt, ...sessionMeta }),
    );
    if (typeof setup.sessionId !== "string" || setup.sessionId === "") {
      return yield* failure(`${harness.name} started no session`)(setup);
    }
    sessionId = setup.sessionId;
  }
  const id = sessionId;
  configOptions = setup.configOptions ?? configOptions;
  let legacyModels: LegacyModelState | undefined = isRecord(setup.models) ? setup.models : undefined;

  // The access mode, as the agent's own mode where it has a fitting one.
  const modes = setup.modes?.availableModes ?? [];
  const mode = harness.modeFor?.(options.access, modes);
  if (mode !== undefined && mode !== setup.modes?.currentModeId) {
    yield* connection
      .request("session/set_mode", { sessionId: id, modeId: mode })
      .pipe(Effect.mapError(refused(`switch to its \`${mode}\` mode`)));
  }

  const setConfig = (configId: string, value: string) =>
    connection
      .request<{ configOptions?: ReadonlyArray<SessionConfigOption> }>("session/set_config_option", {
        sessionId: id,
        configId,
        value,
      })
      .pipe(
        Effect.tap((answer) =>
          Effect.sync(() => {
            if (Array.isArray(answer?.configOptions)) configOptions = answer.configOptions;
          }),
        ),
      );

  let model = options.model;
  let effort: ReasoningEffort | undefined = options.effort;
  const setModel = (next: string) =>
    Effect.gen(function* () {
      const option = configOption(configOptions, "model");
      if (option !== undefined) {
        if (option.type === "select" && option.currentValue === next) return;
        yield* setConfig(option.id, next).pipe(Effect.mapError(refused(`switch to ${next}`)));
      } else if (legacyModels !== undefined) {
        if (legacyModels.currentModelId === next) return;
        yield* connection
          .request("session/set_model", { sessionId: id, modelId: next })
          .pipe(Effect.mapError(refused(`switch to ${next}`)));
        legacyModels = { ...legacyModels, currentModelId: next };
      } else {
        return yield* failure(`${harness.name} offers no model switch in this session`)(configOptions);
      }
      model = next;
    });
  const setEffort = (next: ReasoningEffort) =>
    Effect.gen(function* () {
      const option = configOption(configOptions, "thought_level");
      const value = option === undefined ? undefined : effortValue(option, next);
      if (option === undefined || value === undefined) {
        // The model has no effort setting; the effort it runs at is its own.
        yield* Effect.logDebug(`${harness.name} has no effort setting for ${model}`);
        return;
      }
      if (option.type === "select" && option.currentValue === value) return;
      yield* setConfig(option.id, value).pipe(Effect.mapError(refused("change its effort")));
      effort = next;
    });

  // The model and effort Cerium asked for, where the agent didn't start on them already.
  const startingModel =
    (() => {
      const option = configOption(configOptions, "model");
      return option?.type === "select" ? option.currentValue : legacyModels?.currentModelId;
    })() ?? options.model;
  if (options.model !== "" && options.model !== startingModel) yield* setModel(options.model);
  else model = startingModel;
  if (options.effort !== undefined) yield* setEffort(options.effort);

  emit({ type: "opened", sessionId: id, model, effort });

  /** Sends not yet answered by their `TurnCompleted`, including ones waiting to start. */
  let queued = 0;
  /** An interrupt that arrived before the turn's prompt was sent; the turn ends without it. */
  let interruptRequested = false;
  let inFlight: Deferred.Deferred<void> | undefined;

  const cancel = connection.notify("session/cancel", { sessionId: id }).pipe(Effect.andThen(cancelPending));

  const promptBlocks = (text: string, extras: TurnExtras | undefined): ReadonlyArray<ContentBlock> => {
    const takesImages = capabilities.promptCapabilities?.image === true;
    const images = takesImages ? (extras?.images ?? []) : [];
    const lead = preamble;
    preamble = undefined;
    return [
      { type: "text", text: lead === undefined ? text : `${lead}${text}` },
      ...images.map((image): ContentBlock => ({
        type: "image",
        data: image.data,
        mimeType: image.mediaType,
      })),
    ];
  };

  const compactText = () => {
    const command = harness.compactCommand;
    return command !== undefined && (commands.length === 0 || commands.some((each) => each.name === command))
      ? `/${command}`
      : undefined;
  };

  const runTurn = (turn: Turn) =>
    Effect.gen(function* () {
      if (interruptRequested) {
        interruptRequested = false;
        queued--;
        emit({ type: "promptSkipped" });
        return;
      }
      const done = yield* Deferred.make<void>();
      inFlight = done;
      let prompt: ReadonlyArray<ContentBlock>;
      if ("compact" in turn && harness.compact !== undefined) {
        translator.compactAsked();
        emit({ type: "prompt" });
        const compacted = yield* harness.compact(connection, id).pipe(Effect.exit);
        if (Exit.isSuccess(compacted)) {
          Queue.offerAllUnsafe(events, translator.compactFinished());
          emit({ type: "prompted", response: { stopReason: "end_turn" } });
        } else {
          const error = Cause.squash(compacted.cause);
          emit({
            type: "promptFailed",
            message: `${harness.name} couldn't compact the conversation: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        inFlight = undefined;
        queued--;
        return yield* Deferred.succeed(done, undefined);
      }
      if ("compact" in turn) {
        const text = compactText();
        if (text === undefined) {
          emit({ type: "prompt" });
          emit({ type: "promptFailed", message: `${harness.name} has no compact command in this session.` });
          inFlight = undefined;
          queued--;
          return yield* Deferred.succeed(done, undefined);
        }
        translator.compactAsked();
        prompt = [{ type: "text", text }];
      } else {
        prompt = promptBlocks(turn.text, turn.extras);
      }
      emit({ type: "prompt" });
      const answered = yield* connection
        .request<PromptResponse>("session/prompt", { sessionId: id, prompt })
        .pipe(Effect.exit);
      // Some agents stream their last updates just after answering.
      if (harness.settleMillis !== undefined && harness.settleMillis > 0)
        yield* Effect.sleep(harness.settleMillis);
      if (Exit.isSuccess(answered)) {
        const response = isRecord(answered.value) ? answered.value : { stopReason: "end_turn" as const };
        if ("compact" in turn) Queue.offerAllUnsafe(events, translator.compactFinished());
        emit({ type: "prompted", response: response as PromptResponse });
      } else {
        const error = Cause.squash(answered.cause);
        const acp = error instanceof AcpError ? error : undefined;
        emit({
          type: "promptFailed",
          message: acp?.message ?? (error instanceof Error ? error.message : String(error)),
          code: acp?.code,
          auth: acp !== undefined && isAuthError(acp),
        });
      }
      inFlight = undefined;
      interruptRequested = false;
      queued--;
      yield* Deferred.succeed(done, undefined);
    });

  const input = yield* Queue.unbounded<Turn>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(input).pipe(Effect.flatMap(runTurn))));

  // An agent that exits on its own fails the session; the turn in flight already failed with it.
  yield* connection.exited.pipe(
    Effect.flatMap((code) =>
      closing
        ? Effect.void
        : Queue.fail(
            events,
            failure(
              `${harness.name} exited${code === undefined ? "" : ` with code ${code}`}${connection.stderr() ? `: ${connection.stderr()}` : ""}`,
            )(code),
          ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      const running = inFlight;
      if (running !== undefined) {
        yield* cancel.pipe(
          Effect.andThen(Deferred.await(running)),
          Effect.timeout(STOP_GRACE),
          Effect.ignore,
        );
      }
      if (sessionCapabilities.close !== undefined && sessionCapabilities.close !== null) {
        yield* connection
          .request("session/close", { sessionId: id })
          .pipe(Effect.timeout(CLOSE_GRACE), Effect.ignore);
      }
      if (overrides.ephemeral === true) {
        const remove =
          sessionCapabilities.delete !== undefined && sessionCapabilities.delete !== null
            ? connection.request("session/delete", { sessionId: id })
            : harness.deleteSession?.(connection, id, cwd);
        if (remove !== undefined) yield* remove.pipe(Effect.timeout(CLOSE_GRACE), Effect.ignore);
      }
      yield* Queue.end(events);
    }),
  );

  const respondToPermission = (requestId: string, decision: PermissionDecision) =>
    Effect.gen(function* () {
      const verdict = pending.get(requestId);
      if (verdict === undefined) return;
      Queue.offerAllUnsafe(events, translator.resolved(requestId, decision, decision));
      yield* Deferred.succeed(verdict, { decision });
    });

  const session: AgentSession = {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      Effect.sync(() => queued++).pipe(
        Effect.andThen(Queue.offer(input, { text, ...(extras ? { extras } : {}) })),
        Effect.asVoid,
      ),
    respondToPermission,
    interrupt: Effect.suspend(() => {
      if (queued > (inFlight === undefined ? 0 : 1)) interruptRequested = true;
      return inFlight === undefined ? Effect.void : cancel;
    }),
    setModel: (next) => setModel(next),
    setEffort: (next) => setEffort(next),
    ...(harness.compactCommand === undefined && harness.compact === undefined
      ? {}
      : {
          compact: Effect.sync(() => queued++).pipe(
            Effect.andThen(Queue.offer(input, { compact: true })),
            Effect.asVoid,
          ),
        }),
  };
  return Object.assign(session, {
    opened: { connection, capabilities, sessionId: id } satisfies OpenedSession,
  });
});
