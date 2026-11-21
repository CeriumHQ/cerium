import type {
  AdapterEvent,
  AgentSession,
  HarnessFailure,
  McpServerSpec,
  PermissionDecision,
  SessionOptions,
  TurnExtras,
} from "@cerium/harness";
import type { AccessMode, EventPayload, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Cause, Effect, Queue, Scope, Semaphore, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { callFailure, connect, needsLogin, record, string, type AcpError, type Incoming } from "./acp.ts";
import { writeSessionConfig } from "./config.ts";
import { LOGIN_COMMAND, PROVIDER, SIGNED_OUT, failure } from "./manifest.ts";
import { configOption, readConfigOptions, variantOf, type ConfigOption } from "./models.ts";
import { loginRequired } from "./probe.ts";
import { DevinTranslator, toolName } from "./translate.ts";

const pairs = (fields: Readonly<Record<string, string>> | undefined) =>
  Object.entries(fields ?? {}).map(([name, value]) => ({ name, value }));

const serverSpec = ([name, server]: [string, McpServerSpec]) =>
  server.type === "http"
    ? { name, type: "http", url: server.url, headers: pairs(server.headers) }
    : { name, command: server.command, args: server.args, env: pairs(server.env) };

/**
 * Devin's session modes for Cerium's access. Ask mode withholds its write and shell tools. Code mode
 * accepts workspace edits, which the session's config sends to approval for Cerium's Ask.
 */
const MODES: Record<AccessMode, string> = {
  readOnly: "ask",
  ask: "accept-edits",
  acceptEdits: "accept-edits",
  auto: "smart",
  fullAccess: "bypass",
};

/** The server of an MCP tool as Devin names it (`mcp__server__tool`). */
const mcpServer = (tool: string) => (tool.startsWith("mcp__") ? tool.slice(5).split("__", 1)[0] : undefined);

/** Devin has no appendable system prompt over ACP, so Cerium's instructions open the first turn. */
export const withInstructions = (instructions: string, text: string) =>
  [
    "<cerium_instructions>",
    "Cerium, the app running this session, adds these instructions. Follow them like system instructions.",
    "",
    instructions,
    "</cerium_instructions>",
    "",
    text,
  ].join("\n");

const cancelled = { outcome: { outcome: "cancelled" } };
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

interface Approval {
  readonly id: NonNullable<Incoming["id"]>;
  readonly allow: string | undefined;
  readonly deny: string | undefined;
}

const toStopReason = (result: unknown) => {
  switch (record(result)?.["stopReason"]) {
    case "end_turn":
    case "stop_sequence":
      return "completed";
    case "cancelled":
      return "interrupted";
    case "max_turn_requests":
    case "max_tokens":
      return "maxTurns";
    default:
      return "error";
  }
};

export const startDevinSession = Effect.fn("Devin.startSession")(function* (
  executable: string,
  options: SessionOptions,
  userConfig?: string,
) {
  const cwd = resolve(options.cwd);
  const scope = yield* Scope.Scope;
  const readOnly = options.access === "readOnly";
  const trusted = new Set(options.trustedMcpServers);
  // Read-only sessions get only the servers whose tools run without asking, as approval can't be given.
  const mcpServers = Object.entries(options.mcpServers)
    .filter(([name]) => !readOnly || trusted.has(name))
    .map(serverSpec);
  const injected = new Set(mcpServers.map(({ name }) => name));
  const configFile = yield* writeSessionConfig(
    options.access,
    options.includeUserMcpServers && !readOnly,
    userConfig,
  );
  const acp = yield* connect(executable, cwd, configFile);
  if (
    mcpServers.some((server) => server.type === "http") &&
    record(acp.capabilities?.["mcpCapabilities"])?.["http"] !== true
  ) {
    return yield* failure("This Devin CLI does not support injected HTTP MCP servers");
  }
  if (options.resume !== undefined && acp.capabilities?.["loadSession"] !== true) {
    return yield* failure("This Devin CLI cannot resume sessions over ACP");
  }
  const supportsImages = record(acp.capabilities?.["promptCapabilities"])?.["image"] === true;

  // Loading a session replays its history as updates; nothing is active yet, so they are dropped.
  const sessionMethod = options.resume === undefined ? "session/new" : "session/load";
  const result = yield* acp
    .query(sessionMethod, {
      cwd,
      mcpServers,
      ...(options.resume === undefined ? {} : { sessionId: options.resume }),
    })
    .pipe(
      Effect.catchIf(needsLogin, () => Effect.fail(loginRequired())),
      Effect.mapError((error) =>
        error._tag === "HarnessUnavailable" ? error : callFailure(sessionMethod)(error),
      ),
    );
  const sessionId = options.resume ?? string(record(result)?.["sessionId"]);
  if (sessionId === undefined) return yield* failure("Devin did not open a session");
  const target = { sessionId };
  let config: ReadonlyArray<ConfigOption> = readConfigOptions(record(result)?.["configOptions"]);
  const model = () => configOption(config, "model")?.currentValue ?? options.model;
  const queue = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const serial = yield* Semaphore.make(1);
  let active = false;
  let cancelling = false;
  let disconnected = false;
  let instructions = options.resume === undefined ? options.appendSystemPrompt : undefined;
  const approvals = new Map<string, Approval>();
  const calls = new Map<
    string,
    { readonly name: string; readonly title?: string; readonly input: unknown }
  >();
  const translator = new DevinTranslator();
  const emit = (payload: EventPayload) => Queue.offer(queue, { payload }).pipe(Effect.asVoid);
  const emitAll = (payloads: ReadonlyArray<EventPayload>) =>
    Effect.forEach(payloads, emit, { discard: true });

  const set = (id: string, value: string) =>
    Effect.gen(function* () {
      const option = configOption(config, id);
      if (!option?.options.some((choice) => choice.value === value)) {
        return yield* failure(`Devin does not offer ${value} for ${id} in this session`);
      }
      if (option.currentValue === value) return;
      const answer = yield* acp
        .query("session/set_config_option", { ...target, configId: id, value })
        .pipe(Effect.mapError(callFailure("session/set_config_option")));
      config = readConfigOptions(record(answer)?.["configOptions"]);
      if (configOption(config, id)?.currentValue !== value) {
        return yield* failure(`Devin did not apply ${value} for ${id}`);
      }
    });

  const effort = (value: ReasoningEffort) =>
    Effect.gen(function* () {
      const { efforts } = variantOf(config);
      if (efforts.length === 0) return;
      // `minimal` is Cerium's lowest effort; a model without it takes its own lowest.
      const choice = value === "minimal" && !efforts.includes("minimal") ? efforts[0] : value;
      if (choice === undefined || !efforts.includes(choice)) {
        return yield* failure(`Devin does not offer ${value} effort for ${model()}`);
      }
      yield* set("thought_level", choice);
    });

  const speed = (value: ModelSpeed) =>
    variantOf(config).speeds === undefined && value === "standard" ? Effect.void : set("speed", value);

  const settle = (requestId: string, decision: PermissionDecision, cancel = false) =>
    Effect.gen(function* () {
      const approval = approvals.get(requestId);
      if (approval === undefined) return;
      approvals.delete(requestId);
      // Devin's "always" grants outlive the conversation. Cerium's approval is at most one call.
      const optionId = cancel ? undefined : approval[decision.decision];
      yield* emit({
        _tag: "PermissionResolved",
        requestId,
        decision: decision.decision === "allow" && optionId !== undefined ? "allow" : "deny",
        scope: "once",
      });
      yield* acp.respond(approval.id, optionId === undefined ? cancelled : selected(optionId));
    });

  const cancelApprovals = () =>
    Effect.forEach([...approvals.keys()], (id) => settle(id, { decision: "deny", scope: "once" }, true), {
      discard: true,
    });

  const permission = (id: NonNullable<Incoming["id"]>, params: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      if (params["sessionId"] !== sessionId || !active || cancelling)
        return yield* acp.respond(id, cancelled);
      const tool = record(params["toolCall"]);
      const callId = string(tool?.["toolCallId"]);
      const choices = (Array.isArray(params["options"]) ? params["options"] : []).map(record);
      const allow = string(choices.find((choice) => choice?.["kind"] === "allow_once")?.["optionId"]);
      const deny = string(choices.find((choice) => choice?.["kind"] === "reject_once")?.["optionId"]);
      const refuse = acp.respond(id, deny === undefined ? cancelled : selected(deny));
      if (tool === undefined || allow === undefined) return yield* refuse;
      // The request names the rule it would grant, such as `Exec(npm)` or `mcp__cerium__spawn`.
      const rule = string(record(tool["_meta"])?.["cognition.ai/permissionRule"]);
      const call = callId === undefined ? undefined : calls.get(callId);
      const name = call?.name ?? rule ?? "Tool";
      const server = mcpServer(rule ?? name);
      if (server !== undefined && trusted.has(server) && injected.has(server)) {
        return yield* acp.respond(id, selected(allow));
      }
      const userServer = server !== undefined && !injected.has(server);
      if (readOnly || (userServer && !options.includeUserMcpServers)) return yield* refuse;
      const requestId = randomUUID();
      approvals.set(requestId, { id, allow, deny });
      const editable = string(record(tool["_meta"])?.["cognition.ai/editableCommand"]);
      yield* emit({
        _tag: "PermissionRequested",
        requestId,
        toolName: name,
        summary: editable ?? call?.title ?? rule ?? name,
        input: call?.input ?? {},
      });
    });

  acp.onMessage(({ method, params: raw, id }) =>
    Effect.gen(function* () {
      const params = record(raw);
      if (id !== undefined) {
        if (method === "session/request_permission" && params !== undefined)
          return yield* permission(id, params);
        return yield* acp.reject(id);
      }
      if (method !== "session/update" || params?.["sessionId"] !== sessionId || !active) return;
      const update = record(params["update"]);
      const callId = string(update?.["toolCallId"]);
      if (update?.["sessionUpdate"] === "tool_call" && callId !== undefined) {
        const title = string(update["title"]);
        calls.set(callId, {
          name: toolName(update),
          ...(title === undefined ? {} : { title }),
          input: update["rawInput"] ?? {},
        });
      }
      yield* emitAll(translator.update(update));
    }),
  );

  yield* Effect.addFinalizer(() =>
    active
      ? Effect.void
      : acp.request("session/close", target).pipe(Effect.timeout("2 seconds"), Effect.ignore),
  );
  yield* set("mode", MODES[options.access]);
  yield* set("model", options.model);
  if (options.effort !== undefined) yield* effort(options.effort);
  if (options.speed !== undefined) yield* speed(options.speed);

  const started = variantOf(config);
  yield* emit({
    _tag: "SessionStarted",
    provider: PROVIDER,
    providerSessionId: sessionId,
    model: model(),
    ...(started.defaultEffort === undefined ? {} : { effort: started.defaultEffort }),
  });

  // If the process exits during a prompt, the prompt fiber reports the error and finishes the turn.
  // An idle disconnect ends the stream so the orchestrator can reopen the provider session later.
  yield* acp.exited.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        disconnected = true;
      }),
    ),
    Effect.flatMap(() => (active ? Effect.void : Queue.end(queue))),
    Effect.forkScoped,
  );

  const finish = (answer: unknown, turnModel: string, stopReason: ReturnType<typeof toStopReason>) =>
    Effect.gen(function* () {
      yield* cancelApprovals();
      yield* emitAll(translator.finish(answer, turnModel));
      yield* Effect.sync(() => {
        active = false;
        cancelling = false;
        calls.clear();
        Queue.offerUnsafe(queue, { payload: { _tag: "TurnCompleted", stopReason } });
      });
      if (disconnected) yield* Queue.end(queue);
    });

  const run = (awaitResponse: Effect.Effect<unknown, AcpError | HarnessFailure>, turnModel: string) =>
    awaitResponse.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            if (needsLogin(error)) {
              yield* emit({
                _tag: "AuthRequired",
                provider: PROVIDER,
                reason: SIGNED_OUT,
                loginCommand: LOGIN_COMMAND,
              });
            } else {
              yield* emit({
                _tag: "AgentError",
                kind: "unknown",
                message: callFailure("session/prompt")(error).message,
                retryable: false,
              });
            }
            yield* finish(undefined, turnModel, "error");
          }),
        onSuccess: (answer) =>
          Effect.gen(function* () {
            const reason = cancelling ? "interrupted" : toStopReason(answer);
            if (reason === "error") {
              yield* emit({
                _tag: "AgentError",
                kind: "unknown",
                message: "Devin stopped the turn without completing it",
                retryable: false,
              });
            }
            yield* finish(answer, turnModel, reason);
          }),
      }),
    );

  const whenIdle = (operation: Effect.Effect<void, HarnessFailure>) =>
    serial.withPermit(
      Effect.suspend(() =>
        disconnected
          ? Effect.fail(failure("The Devin ACP process exited"))
          : active
            ? Effect.fail(failure("A Devin turn is still running"))
            : operation,
      ),
    );

  return {
    events: Stream.fromQueue(queue),
    send: (text, extras?: TurnExtras) =>
      whenIdle(
        Effect.gen(function* () {
          if (extras?.images?.length) {
            const images = configOption(config, "model")?.options.find(
              ({ value }) => value === model(),
            )?.images;
            if (!supportsImages || images === false) {
              return yield* failure(`Devin's ${model()} does not accept images`);
            }
          }
          const prompt = [
            { type: "text", text: instructions === undefined ? text : withInstructions(instructions, text) },
            ...(extras?.images ?? []).map(({ mediaType, data }) => ({
              type: "image",
              mimeType: mediaType,
              data,
            })),
          ];
          active = true;
          const { awaitResponse } = yield* acp.beginRequest("session/prompt", { ...target, prompt });
          instructions = undefined;
          yield* run(awaitResponse, model()).pipe(Effect.interruptible, Effect.forkIn(scope));
        }).pipe(Effect.uninterruptible),
      ),
    respondToPermission: (id, decision) => Effect.suspend(() => settle(id, decision, cancelling)),
    interrupt: Effect.suspend(() => {
      if (!active || cancelling) return Effect.void;
      cancelling = true;
      return acp.notify("session/cancel", target).pipe(Effect.andThen(Effect.suspend(cancelApprovals)));
    }),
    setModel: (value) => whenIdle(set("model", value)),
    setEffort: (value) => whenIdle(effort(value)),
    setSpeed: (value) => whenIdle(speed(value)),
  } satisfies AgentSession;
});
