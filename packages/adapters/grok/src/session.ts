import {
  type AdapterEvent,
  type AgentSession,
  type HarnessFailure,
  type PermissionDecision,
  type SessionOptions,
} from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";
import { Effect, Queue, Stream, type Cause } from "effect";
import { randomUUID } from "node:crypto";

import { authenticate, initialize, signedOut } from "./catalog.ts";
import { LOGIN_COMMAND, SIGNED_OUT } from "./manifest.ts";
import { array, connect, failure, object, string, type Incoming, type RpcId } from "./rpc.ts";
import { toolName, TurnUpdates, usageFromPrompt } from "./translate.ts";

const READ_TOOLS = ["read_file", "list_dir", "grep"];
const CODING_TOOLS = ["run_terminal_cmd", "run_terminal_command", "search_replace", "write", "todo_write"];
const HOOK_ID = "cerium-pre-tool-use";
const APPROVAL_TIMEOUT_MS = 240_000;

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure("Grok Build did not respond to the ACP request")),
    }),
  );

const mcpServersFor = (options: SessionOptions) =>
  Object.entries(options.mcpServers).flatMap(([name, server]) => {
    if (options.access === "readOnly" && !options.trustedMcpServers?.includes(name)) return [];
    return [
      server.type === "http"
        ? {
            type: "http",
            name,
            url: server.url,
            headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
          }
        : {
            name,
            command: server.command,
            args: server.args,
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
          },
    ];
  });

interface PendingPermission {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly reply: (allow: boolean, message?: string) => boolean;
}

const denyHook = (message = "Cerium denied this tool call.") => ({
  decision: "deny",
  systemMessage: message,
});
const continueHook = { decision: "continue" };
const cancelPermission = { outcome: { outcome: "cancelled" } };

export const startGrokSession = Effect.fn("GrokAdapter.startSession")(function* (
  executable: string,
  options: SessionOptions,
) {
  const scope = yield* Effect.scope;
  const readOnly = options.access === "readOnly";
  const fullAccess = options.access === "fullAccess";
  const client = yield* connect(
    executable,
    options.cwd,
    readOnly ? "read-only" : fullAccess ? "off" : "workspace",
    !readOnly && options.includeUserMcpServers,
  );
  const info = yield* timed(initialize(client));
  yield* timed(authenticate(client, info));

  const capabilities = object(info["agentCapabilities"]);
  const meta = object(capabilities?.["_meta"]);
  const hooks = object(meta?.["x.ai/hooks"]);
  if (!array(hooks?.["blockingEvents"]).includes("pre_tool_use")) {
    return yield* failure(
      "This version of Grok Build does not advertise the tool approval hook Cerium requires",
    );
  }
  if (
    options.resume !== undefined &&
    object(capabilities?.["sessionCapabilities"])?.["resume"] === undefined
  ) {
    return yield* failure("This version of Grok Build does not support ACP session resume");
  }
  const mcpServers = mcpServersFor(options);
  if (
    mcpServers.some((server) => "type" in server) &&
    object(capabilities?.["mcpCapabilities"])?.["http"] !== true
  ) {
    return yield* failure("This version of Grok Build cannot use Cerium's HTTP MCP servers");
  }

  // ACP ignores several tool-filtering flags from the interactive CLI. Curate the actual session
  // profile so the model never receives native agent, workflow, question or planning tools.
  const tools: unknown[] = READ_TOOLS.map((name) => ({ id: `GrokBuild:${name}` }));
  if (mcpServers.length > 0 || (!readOnly && options.includeUserMcpServers)) {
    tools.push({ id: "GrokBuild:search_tool" }, { id: "GrokBuild:use_tool" });
  }
  if (!readOnly) {
    tools.push(
      { id: "GrokBuild:run_terminal_cmd", params: { enabled_background: false } },
      { id: "GrokBuild:search_replace" },
      { id: "OpenCode:write" },
      { id: "GrokBuild:todo_write" },
    );
  }
  const params = {
    cwd: options.cwd,
    mcpServers,
    _meta: {
      clientIdentifier: "cerium",
      "x.ai/restore_code": false,
      "x.ai/skip_envrc": true,
      rules: options.appendSystemPrompt,
      yoloMode: fullAccess,
      autoMode: options.access === "auto",
      agentProfile: {
        name: "cerium",
        description: "Grok Build in Cerium",
        injectDefaultTools: false,
        toolConfig: { tools },
      },
      "x.ai/hooks": { PreToolUse: [{ hookCallbackIds: [HOOK_ID], timeout: 300 }] },
    },
  };

  let setup = object(
    yield* timed(
      client.request(
        options.resume === undefined ? "session/new" : "session/resume",
        options.resume === undefined ? params : { ...params, sessionId: options.resume },
      ),
    ).pipe(Effect.mapError((error) => (error.cause === -32000 ? signedOut() : error))),
  );
  const sessionId = options.resume ?? string(setup?.["sessionId"]);
  if (setup === undefined || sessionId === undefined)
    return yield* failure("Grok Build did not open a session");

  const configValue = (configId: string) =>
    array(setup?.["configOptions"])
      .map(object)
      .find((entry) => entry?.["id"] === configId)?.["currentValue"];
  const configure = (configId: string, value: string) =>
    Effect.gen(function* () {
      if (configValue(configId) === value) return;
      const response = object(
        yield* timed(client.request("session/set_config_option", { sessionId, configId, value })),
      );
      if (response !== undefined) setup = response;
      if (configValue(configId) !== value)
        return yield* failure(`Grok Build did not apply the ${configId} setting`);
    });

  yield* configure("model", options.model);
  if (options.effort !== undefined) yield* configure("reasoning_effort", options.effort);

  const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const emit = (payload: EventPayload) => Queue.offerUnsafe(events, { payload });
  const permissions = new Map<string, PendingPermission>();
  const approvedCalls = new Map<string, string>();
  const injectedNames = mcpServers.map(({ name }) => name);
  const trustedNames = injectedNames.filter((name) => options.trustedMcpServers?.includes(name));
  let turn: TurnUpdates | undefined;
  let interrupted = false;

  const resolve = (requestId: string, decision: PermissionDecision) => {
    const pending = permissions.get(requestId);
    if (pending === undefined) return;
    permissions.delete(requestId);
    clearTimeout(pending.timer);
    const allowed = pending.reply(decision.decision === "allow" && !interrupted, decision.message);
    // Grok's *_always options persist in its own project store. Cerium only grants once.
    emit({ _tag: "PermissionResolved", requestId, decision: allowed ? "allow" : "deny", scope: "once" });
  };
  const expirePermissions = () => {
    for (const id of permissions.keys()) resolve(id, { decision: "deny", scope: "once" });
  };
  const ask = (name: string, summary: string, input: unknown, reply: PendingPermission["reply"]) => {
    const requestId = randomUUID();
    const timer = setTimeout(
      () => resolve(requestId, { decision: "deny", scope: "once" }),
      APPROVAL_TIMEOUT_MS,
    );
    timer.unref();
    permissions.set(requestId, { timer, reply });
    emit({ _tag: "PermissionRequested", requestId, toolName: name, summary, input });
  };

  const fromServer = (tool: string, names: ReadonlyArray<string>) =>
    tool.includes("__") && names.includes(tool.split("__", 1)[0] ?? "");
  const acceptsTool = (name: string) =>
    !readOnly &&
    (CODING_TOOLS.includes(name) ||
      fromServer(name, injectedNames) ||
      (options.includeUserMcpServers && name.includes("__")));
  // Grok can call an MCP tool directly or through its discovery wrapper. Authorize the actual
  // target and inline arguments, never an opaque file-backed target or a native tool via the wrapper.
  const toolTarget = (tool: string | undefined, input: unknown) => {
    if (tool !== "use_tool") return { name: tool, input };
    const body = object(input);
    const target = string(body?.["tool_name"]);
    return {
      name:
        target?.includes("__") && body?.["file"] == null && body?.["tool_input_file"] == null
          ? target
          : undefined,
      input: body?.["tool_input"],
    };
  };
  const approvalKey = (name: string, input: unknown) => JSON.stringify([name, input]);
  const hookRequest = (id: RpcId, params: Incoming["params"]) => {
    const { name, input } = toolTarget(string(params["toolName"]), params["toolInput"]);
    const callId = string(params["toolUseId"]);
    if (
      params["hookCallbackId"] !== HOOK_ID ||
      params["sessionId"] !== sessionId ||
      turn === undefined ||
      interrupted ||
      name === undefined ||
      callId === undefined
    ) {
      client.respond(id, denyHook());
      return;
    }
    if (READ_TOOLS.includes(name) || name === "search_tool" || fromServer(name, trustedNames)) {
      approvedCalls.set(callId, approvalKey(name, input));
      client.respond(id, continueHook);
      return;
    }
    // Grok can merge configured MCP tools even into curated profiles. Scope their execution here.
    if (!acceptsTool(name)) {
      client.respond(id, denyHook("This tool is outside the session's access policy."));
      return;
    }
    if (fullAccess || options.access === "auto" || name === "todo_write") {
      client.respond(id, continueHook);
      return;
    }
    const summary = string(object(input)?.["command"]) ?? string(object(input)?.["description"]) ?? name;
    ask(name, summary, input, (allow, message) => {
      if (allow) approvedCalls.set(callId, approvalKey(name, input));
      client.respond(id, allow ? continueHook : denyHook(message));
      return allow;
    });
  };

  const nativePermission = (id: RpcId, params: Incoming["params"]) => {
    const call = object(params["toolCall"]);
    if (params["sessionId"] !== sessionId || turn === undefined || interrupted || call === undefined) {
      client.respond(id, cancelPermission);
      return;
    }
    const choices = array(params["options"]).map(object);
    const reply = (allow: boolean) => {
      if (interrupted) {
        client.respond(id, cancelPermission);
        return false;
      }
      const optionId = string(
        choices.find((option) => option?.["kind"] === (allow ? "allow_once" : "reject_once"))?.["optionId"],
      );
      client.respond(
        id,
        optionId === undefined ? cancelPermission : { outcome: { outcome: "selected", optionId } },
      );
      return allow && optionId !== undefined;
    };
    const toolMeta = object(object(call["_meta"])?.["x.ai/tool"]);
    const { name, input } = toolTarget(toolName(call), toolMeta?.["input"] ?? call["rawInput"]);
    const callId = string(call["toolCallId"]);
    if (name === undefined) {
      reply(false);
    } else if (
      READ_TOOLS.includes(name) ||
      name === "search_tool" ||
      fromServer(name, trustedNames) ||
      (callId !== undefined && approvedCalls.get(callId) === approvalKey(name, input))
    ) {
      reply(true);
    } else if (!acceptsTool(name)) {
      reply(false);
    } else {
      ask(name, string(call["title"]) ?? name, input, reply);
    }
  };

  client.receive(({ method, id, params }) => {
    if (id !== undefined) {
      if (method === "_x.ai/hooks/run" || method === "x.ai/hooks/run") hookRequest(id, params);
      else if (method === "session/request_permission") nativePermission(id, params);
      else client.unsupported(id);
      return;
    }
    if (params["sessionId"] !== sessionId || method !== "session/update") return;
    const update = object(params["update"]);
    if (update !== undefined) turn?.update(update);
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      interrupted = true;
      expirePermissions();
      Queue.endUnsafe(events);
    }),
  );
  const emitError = (message: string) =>
    emit({ _tag: "AgentError", kind: "unknown", message, retryable: false });
  yield* client.exited.pipe(
    Effect.andThen(
      Effect.sync(() => {
        // An active prompt observes the same exit through its pending RPC request.
        if (turn === undefined) {
          emitError("The Grok Build process exited.");
          Queue.endUnsafe(events);
        }
      }),
    ),
    Effect.forkScoped,
  );
  emit({
    _tag: "SessionStarted",
    provider: "grok",
    providerSessionId: sessionId,
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  });

  return {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      Effect.gen(function* () {
        if (client.isClosed()) return yield* failure("The Grok Build ACP connection closed");
        if (turn !== undefined) return yield* failure("Grok Build already has a turn in flight");
        if (extras?.images?.length && object(capabilities?.["promptCapabilities"])?.["image"] !== true) {
          return yield* failure("This version of Grok Build does not accept ACP images");
        }
        const currentTurn = new TurnUpdates(emit);
        turn = currentTurn;
        interrupted = false;
        const prompt = [
          { type: "text", text },
          ...(extras?.images ?? []).map(({ data, mediaType }) => ({
            type: "image",
            data,
            mimeType: mediaType,
          })),
        ];
        yield* client
          .request("session/prompt", {
            sessionId,
            prompt,
            _meta: { verbatim: true, promptId: extras?.turnId },
          })
          .pipe(
            Effect.match({
              onSuccess: (response) => {
                currentTurn.flush();
                expirePermissions();
                turn = undefined;
                approvedCalls.clear();
                const usage = usageFromPrompt(response);
                if (usage !== undefined) emit(usage);
                const reason = object(response)?.["stopReason"];
                if (reason === "cancelled" || interrupted) {
                  emit({ _tag: "TurnCompleted", stopReason: "interrupted" });
                } else if (reason === "max_turn_requests" || reason === "max_tokens") {
                  emit({ _tag: "TurnCompleted", stopReason: "maxTurns" });
                } else if (reason === "end_turn" || reason === "stop_sequence") {
                  emit({ _tag: "TurnCompleted", stopReason: "completed" });
                } else {
                  emitError("Grok Build stopped before completing the turn.");
                  emit({ _tag: "TurnCompleted", stopReason: "error" });
                }
              },
              onFailure: (error) => {
                currentTurn.flush();
                expirePermissions();
                turn = undefined;
                approvedCalls.clear();
                if (error.cause === -32000)
                  emit({
                    _tag: "AuthRequired",
                    provider: "grok",
                    reason: SIGNED_OUT,
                    loginCommand: LOGIN_COMMAND,
                  });
                else if (!interrupted) emitError(error.message);
                emit({ _tag: "TurnCompleted", stopReason: interrupted ? "interrupted" : "error" });
                if (client.isClosed()) Queue.endUnsafe(events);
              },
            }),
            Effect.forkIn(scope, { startImmediately: true }),
            Effect.asVoid,
          );
      }),
    respondToPermission: (requestId, decision) => Effect.sync(() => resolve(requestId, decision)),
    interrupt: Effect.suspend((): Effect.Effect<void, HarnessFailure> => {
      if (turn === undefined) return Effect.void;
      interrupted = true;
      expirePermissions();
      return client.notify("session/cancel", { sessionId });
    }),
    setModel: (next) => configure("model", next),
    setEffort: (effort) => configure("reasoning_effort", effort),
  } satisfies AgentSession;
});
