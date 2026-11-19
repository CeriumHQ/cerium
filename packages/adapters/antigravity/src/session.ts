import type {
  AdapterEvent,
  AgentSession,
  HarnessFailure,
  McpServerSpec,
  PermissionDecision,
  SessionOptions,
  TurnExtras,
} from "@cerium/harness";
import type { EventPayload, ReasoningEffort } from "@cerium/protocol";
import { Cause, Effect, Queue, Scope, Semaphore, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { callFailure, connect, needsLogin, record, string, type AcpError, type Incoming } from "./acp.ts";
import { LOGIN_COMMAND, PROVIDER, SIGNED_OUT, failure } from "./manifest.ts";
import { readConfig, readSessionDetails, toModelInfos } from "./models.ts";
import { loginRequired } from "./probe.ts";
import { AntigravityTranslator } from "./translate.ts";

const pairs = (fields: Readonly<Record<string, string>> | undefined) =>
  Object.entries(fields ?? {}).map(([name, value]) => ({ name, value }));

const serverSpec = ([name, server]: [string, McpServerSpec]) =>
  server.type === "http"
    ? { name, type: "http", url: server.url, headers: pairs(server.headers) }
    : { name, type: "stdio", command: server.command, args: server.args, env: pairs(server.env) };

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

export const startAntigravitySession = Effect.fn("Antigravity.startSession")(function* (
  executable: string,
  options: SessionOptions,
) {
  if (options.access === "readOnly") return yield* failure("Antigravity cannot enforce read-only access");
  if (!options.includeUserMcpServers) {
    return yield* failure("Antigravity cannot start a session with the user's MCP configuration disabled");
  }
  if (options.speed !== undefined && options.speed !== "standard") {
    return yield* failure("Antigravity does not support speed selection");
  }

  const cwd = resolve(options.cwd);
  const scope = yield* Scope.Scope;
  const flags: Array<string> = [];
  const mcpServers = Object.entries(options.mcpServers).map(serverSpec);
  const httpMcp = mcpServers.some(({ type }) => type === "http");
  // Antigravity only advertises and accepts HTTP MCP in the isolated worker topology.
  if (httpMcp) flags.push("--process-per-session");
  if (options.access === "fullAccess") flags.push("--dangerously-skip-permissions");
  if (options.access === "auto") flags.push("--sandbox");
  const acp = yield* connect(executable, cwd, flags);
  if (httpMcp && record(acp.capabilities?.["mcpCapabilities"])?.["http"] !== true) {
    return yield* failure("This Antigravity CLI does not support injected HTTP MCP servers");
  }
  const supportsImages = record(acp.capabilities?.["promptCapabilities"])?.["image"] === true;
  const antigravity = record(record(acp.capabilities?.["_meta"])?.["antigravity"]);
  const instructions = options.appendSystemPrompt;
  if (instructions && record(antigravity?.["systemPrompt"])?.["append"] !== true) {
    return yield* failure("This Antigravity CLI cannot append Cerium's system instructions");
  }

  const sessionMethod = options.resume === undefined ? "session/new" : "session/resume";
  const result = yield* acp
    .query(sessionMethod, {
      cwd,
      mcpServers,
      ...(options.resume === undefined ? {} : { sessionId: options.resume }),
      _meta: {
        antigravity: {
          eagerMcpServers: mcpServers.map(({ name }) => name),
          ...(instructions ? { systemPrompt: { append: instructions } } : {}),
        },
      },
    })
    .pipe(
      Effect.catchIf(needsLogin, () => Effect.fail(loginRequired())),
      Effect.mapError((error) =>
        error._tag === "HarnessUnavailable" ? error : callFailure(sessionMethod)(error),
      ),
    );
  const details = yield* readSessionDetails(result).pipe(
    Effect.mapError(() => failure("Antigravity returned invalid session information")),
  );
  const { sessionId } = details;
  const target = { sessionId };
  let config = details.configOptions;
  const current = (id: string) => config.find((option) => option.id === id);
  const model = () => current("model")?.currentValue ?? details.models.currentModelId;
  const models = toModelInfos(details);
  const queue = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const serial = yield* Semaphore.make(1);
  let active = false;
  let cancelling = false;
  let disconnected = false;
  const approvals = new Map<string, Approval>();
  const translator = new AntigravityTranslator();
  const emit = (payload: EventPayload) => Queue.offer(queue, { payload }).pipe(Effect.asVoid);
  const emitAll = (payloads: ReadonlyArray<EventPayload>) =>
    Effect.forEach(payloads, emit, { discard: true });

  const set = (id: string, value: string) =>
    Effect.gen(function* () {
      const option = current(id);
      if (!option?.options.some((choice) => choice.value === value)) {
        return yield* failure(`Antigravity does not offer ${value} for ${id} in this session`);
      }
      if (option.currentValue === value) return;
      config = yield* acp
        .query("session/set_config_option", { ...target, configId: id, value })
        .pipe(Effect.mapError(callFailure("session/set_config_option")), Effect.flatMap(readConfig));
      if (current(id)?.currentValue !== value) {
        return yield* failure(`Antigravity did not apply ${value} for ${id}`);
      }
    });

  const effort = (value: ReasoningEffort) =>
    Effect.gen(function* () {
      const supported = models.find(({ id }) => id === model())?.efforts ?? [];
      const choice = value === "minimal" ? supported[0] : value;
      if (choice === undefined) return;
      if (!supported.includes(choice))
        return yield* failure(`Antigravity does not offer ${choice} effort for ${model()}`);
      yield* set("thought_level", choice);
    });

  const settle = (requestId: string, decision: PermissionDecision, cancel = false) =>
    Effect.gen(function* () {
      const approval = approvals.get(requestId);
      if (approval === undefined) return;
      approvals.delete(requestId);
      // ACP's "always" grants can outlive the conversation. Cerium's approval is at most one call.
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

  acp.onMessage(({ method, params: raw, id }) =>
    Effect.gen(function* () {
      const params = record(raw);
      if (id === undefined) {
        if (method === "session/update" && params?.["sessionId"] === sessionId && active) {
          yield* emitAll(translator.update(params["update"]));
        }
        return;
      }
      if (method !== "session/request_permission") return yield* acp.reject(id);
      if (params?.["sessionId"] !== sessionId || !active || cancelling)
        return yield* acp.respond(id, cancelled);
      const tool = record(params["toolCall"]);
      if (tool === undefined) return yield* acp.respond(id, cancelled);
      const choices = (Array.isArray(params["options"]) ? params["options"] : []).map(record);
      const allow = string(choices.find((choice) => choice?.["kind"] === "allow_once")?.["optionId"]);
      const deny = string(choices.find((choice) => choice?.["kind"] === "reject_once")?.["optionId"]);
      if (allow === undefined) return yield* acp.respond(id, deny === undefined ? cancelled : selected(deny));
      const requestId = randomUUID();
      approvals.set(requestId, { id, allow, deny });
      const toolName = string(tool["name"]) ?? string(tool["kind"]) ?? "Tool";
      yield* emit({
        _tag: "PermissionRequested",
        requestId,
        toolName,
        summary: string(tool["title"]) ?? toolName,
        input: tool["rawInput"] ?? tool["args"] ?? {},
      });
    }),
  );

  yield* Effect.addFinalizer(() =>
    active
      ? Effect.void
      : acp.request("session/close", target).pipe(Effect.timeout("2 seconds"), Effect.ignore),
  );
  yield* set(
    "mode",
    options.access === "acceptEdits" ? "accept-edits" : options.access === "auto" ? "auto" : "default",
  );
  yield* set("model", options.model);
  if (options.effort !== undefined) yield* effort(options.effort);

  const activeModel = models.find(({ id }) => id === model());
  const activeEffort = activeModel?.efforts.find((value) => value === current("thought_level")?.currentValue);
  yield* emit({
    _tag: "SessionStarted",
    provider: PROVIDER,
    providerSessionId: sessionId,
    model: model(),
    ...(activeEffort === undefined ? {} : { effort: activeEffort }),
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

  const run = (awaitResponse: Effect.Effect<unknown, AcpError | HarnessFailure>, turnModel: string) =>
    awaitResponse.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            const signedOut = needsLogin(error);
            if (signedOut)
              yield* emit({
                _tag: "AuthRequired",
                provider: PROVIDER,
                reason: SIGNED_OUT,
                loginCommand: LOGIN_COMMAND,
              });
            if (!signedOut) {
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
            const reason = toStopReason(answer);
            if (reason === "error") {
              yield* emit({
                _tag: "AgentError",
                kind: "unknown",
                message: "Antigravity stopped the turn without completing it",
                retryable: false,
              });
            }
            yield* finish(answer, turnModel, reason);
          }),
      }),
    );

  const finish = (answer: unknown, turnModel: string, stopReason: ReturnType<typeof toStopReason>) =>
    Effect.gen(function* () {
      yield* cancelApprovals();
      yield* emitAll(translator.finish(answer, turnModel));
      yield* Effect.sync(() => {
        active = false;
        cancelling = false;
        Queue.offerUnsafe(queue, { payload: { _tag: "TurnCompleted", stopReason } });
      });
      if (disconnected) yield* Queue.end(queue);
    });

  const whenIdle = (operation: Effect.Effect<void, HarnessFailure>) =>
    serial.withPermit(
      Effect.suspend(() =>
        disconnected
          ? Effect.fail(failure("The Antigravity ACP process exited"))
          : active
            ? Effect.fail(failure("An Antigravity turn is still running"))
            : operation,
      ),
    );

  return {
    events: Stream.fromQueue(queue),
    send: (text, extras?: TurnExtras) =>
      whenIdle(
        Effect.gen(function* () {
          if (extras?.images?.length && !supportsImages)
            return yield* failure("This Antigravity CLI does not accept images");
          const prompt = [
            { type: "text", text },
            ...(extras?.images ?? []).map(({ mediaType, data }) => ({
              type: "image",
              mimeType: mediaType,
              data,
            })),
          ];
          active = true;
          const { awaitResponse } = yield* acp.beginRequest("session/prompt", { ...target, prompt });
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
  } satisfies AgentSession;
});
