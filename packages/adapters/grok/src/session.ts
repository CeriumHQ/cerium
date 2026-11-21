import {
  acpMcpServers,
  answerOnce,
  array,
  cancelledOutcome,
  hasHttpMcp,
  makeAcpSession,
  makeConfigState,
  onceOptions,
  openSession,
  readConfigOptions,
  record,
  string,
  type AcpConnection,
  type ApprovalRequest,
  type RequestHandler,
} from "@cerium/acp";
import type { AgentSession, SessionOptions, TurnExtras } from "@cerium/harness";
import { Effect, type Scope } from "effect";

import { authenticate, connectGrok } from "./catalog.ts";
import { PROVIDER, failure } from "./manifest.ts";
import { makeGrokTasks } from "./tasks.ts";
import { grokTranslator, toolName } from "./translate.ts";

const READ_TOOLS = ["read_file", "list_dir", "grep"];
const CODING_TOOLS = ["run_terminal_cmd", "run_terminal_command", "search_replace", "write", "todo_write"];
const HOOK_ID = "cerium-pre-tool-use";
/** Grok waits 300 seconds for the hook; an unanswered approval is denied before then. */
const APPROVAL_TIMEOUT = "240 seconds";

const denyHook = (message = "Cerium denied this tool call.") => ({
  decision: "deny",
  systemMessage: message,
});
const continueHook = { decision: "continue" };

export const startGrokSession = Effect.fn("GrokAdapter.startSession")(function* (
  executable: string,
  options: SessionOptions,
  registerMcp?: (acp: AcpConnection, sessionId: string) => Effect.Effect<void, never, Scope.Scope>,
) {
  const readOnly = options.access === "readOnly";
  const fullAccess = options.access === "fullAccess";
  const acp = yield* connectGrok(
    executable,
    options.cwd,
    readOnly ? "read-only" : fullAccess ? "off" : "workspace",
    !readOnly && options.includeUserMcpServers,
  );
  yield* authenticate(acp);

  const hooks = record(record(acp.agent.capabilities?.["_meta"])?.["x.ai/hooks"]);
  if (!array(hooks?.["blockingEvents"]).includes("pre_tool_use")) {
    return yield* failure(
      "This version of Grok Build does not advertise the tool approval hook Cerium requires",
    );
  }
  if (options.resume !== undefined && !acp.agent.resumeSession) {
    return yield* failure("This version of Grok Build does not support ACP session resume");
  }
  const mcpServers = acpMcpServers(options);
  if (hasHttpMcp(mcpServers) && !acp.agent.httpMcp) {
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
      { id: "GrokBuild:run_terminal_cmd", params: { enabled_background: true } },
      { id: "GrokBuild:search_replace" },
      { id: "OpenCode:write" },
      { id: "GrokBuild:todo_write" },
    );
  }
  const result = yield* openSession(acp, options.resume === undefined ? "session/new" : "session/resume", {
    cwd: options.cwd,
    mcpServers,
    ...(options.resume === undefined ? {} : { sessionId: options.resume }),
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
  });
  const setup = record(result);
  const sessionId = options.resume ?? string(setup?.["sessionId"]);
  if (setup === undefined || sessionId === undefined)
    return yield* failure("Grok Build did not open a session");
  // Grok reports each option's current value only, not the values it offers.
  const config = makeConfigState({
    acp,
    sessionId,
    initial: readConfigOptions(setup["configOptions"]),
    requireOffered: false,
  });

  const injectedNames = mcpServers.map(({ name }) => name);
  const trustedNames = injectedNames.filter((name) => options.trustedMcpServers?.includes(name));
  /** Calls the hook let through, which Grok's own permission request for the same call then repeats. */
  const approvedCalls = new Map<string, string>();
  const approvalKey = (name: string, input: unknown) => JSON.stringify([name, input]);

  const fromServer = (tool: string, names: ReadonlyArray<string>) =>
    tool.includes("__") && names.includes(tool.split("__", 1)[0] ?? "");
  const runsFreely = (name: string) =>
    READ_TOOLS.includes(name) || name === "search_tool" || fromServer(name, trustedNames);
  const acceptsTool = (name: string) =>
    !readOnly &&
    (CODING_TOOLS.includes(name) ||
      fromServer(name, injectedNames) ||
      (options.includeUserMcpServers && name.includes("__")));
  // Grok can call an MCP tool directly or through its discovery wrapper. Authorize the actual
  // target and inline arguments, never an opaque file-backed target or a native tool via the wrapper.
  const toolTarget = (tool: string | undefined, input: unknown) => {
    if (tool !== "use_tool") return { name: tool, input };
    const body = record(input);
    const target = string(body?.["tool_name"]);
    return {
      name:
        target?.includes("__") && body?.["file"] == null && body?.["tool_input_file"] == null
          ? target
          : undefined,
      input: body?.["tool_input"],
    };
  };

  /** Grok's blocking `pre_tool_use` hook, which every tool call passes before it runs. */
  const hook: RequestHandler = (id, params, session) => {
    const { name, input } = toolTarget(string(params["toolName"]), params["toolInput"]);
    const callId = string(params["toolUseId"]);
    if (
      params["hookCallbackId"] !== HOOK_ID ||
      !session.accepting(params) ||
      name === undefined ||
      callId === undefined
    ) {
      return acp.respond(id, denyHook());
    }
    if (runsFreely(name)) {
      approvedCalls.set(callId, approvalKey(name, input));
      return acp.respond(id, continueHook);
    }
    // Grok can merge configured MCP tools even into curated profiles. Scope their execution here.
    if (!acceptsTool(name))
      return acp.respond(id, denyHook("This tool is outside the session's access policy."));
    if (fullAccess || options.access === "auto" || name === "todo_write")
      return acp.respond(id, continueHook);
    const body = record(input);
    return session.ask({
      id,
      toolName: name,
      summary: string(body?.["command"]) ?? string(body?.["description"]) ?? name,
      input,
      answer: ({ allow, message }) => {
        if (allow) approvedCalls.set(callId, approvalKey(name, input));
        return { allowed: allow, result: allow ? continueHook : denyHook(message) };
      },
    });
  };

  /** ACP's own permission request, which Grok also sends for some calls the hook has seen. */
  const permission: RequestHandler = (id, params, session) => {
    const call = record(params["toolCall"]);
    if (!session.accepting(params) || call === undefined) return acp.respond(id, cancelledOutcome);
    const answer: ApprovalRequest["answer"] = answerOnce(onceOptions(params));
    const toolMeta = record(record(call["_meta"])?.["x.ai/tool"]);
    const { name, input } = toolTarget(toolName(call), toolMeta?.["input"] ?? call["rawInput"]);
    const callId = string(call["toolCallId"]);
    const reply = (allow: boolean) => acp.respond(id, answer({ allow, cancelled: false }).result);
    if (name === undefined) return reply(false);
    if (
      runsFreely(name) ||
      (callId !== undefined && approvedCalls.get(callId) === approvalKey(name, input))
    ) {
      return reply(true);
    }
    if (!acceptsTool(name)) return reply(false);
    return session.ask({ id, toolName: name, summary: string(call["title"]) ?? name, input, answer });
  };

  const tasks = yield* makeGrokTasks(acp, sessionId);
  const session = yield* makeAcpSession({
    acp,
    sessionId,
    translator: grokTranslator(),
    permission,
    requests: { "_x.ai/hooks/run": hook, "x.ai/hooks/run": hook },
    approvalTimeout: APPROVAL_TIMEOUT,
    closeOnExit: false,
    idleExitMessage: "The Grok Build process exited.",
    onTurnEnd: () => approvedCalls.clear(),
    notification: (method, params, active) =>
      params["sessionId"] === sessionId &&
      (method === "_x.ai/task_backgrounded" || method === "_x.ai/task_completed")
        ? tasks.refreshInBackground(active)
        : Effect.void,
  });
  if (options.resume !== undefined) yield* tasks.refreshInBackground(session);
  if (!readOnly && options.includeUserMcpServers && registerMcp !== undefined)
    yield* registerMcp(acp, sessionId);

  yield* config.set("model", options.model);
  if (options.effort !== undefined) yield* config.set("reasoning_effort", options.effort);
  yield* session.emit({
    _tag: "SessionStarted",
    provider: PROVIDER,
    providerSessionId: sessionId,
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  });

  const model = () => config.current("model")?.currentValue ?? options.model;
  return {
    events: session.events,
    send: (text: string, extras?: TurnExtras) =>
      session.send(text, extras, () =>
        Effect.succeed({ model: model(), meta: { verbatim: true, promptId: extras?.turnId } }),
      ),
    compact: session.compact("_x.ai/compact_conversation", { session_id: sessionId }, model),
    stopBackgroundTask: (id) => tasks.stop(session, id),
    respondToPermission: session.respondToPermission,
    interrupt: session.interrupt,
    setModel: (next) => session.whenIdle(config.set("model", next)),
    setEffort: (effort) => session.whenIdle(config.set("reasoning_effort", effort)),
  } satisfies AgentSession;
});
