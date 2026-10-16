import {
  query,
  type CanUseTool,
  type EffortLevel,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  HarnessFailure,
  type AdapterEvent,
  type AgentSession,
  type McpServerSpec,
  type PermissionDecision,
  type SessionOptions,
} from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Effect, Queue, Stream } from "effect";

import { NATIVE_SUBAGENT_TOOLS } from "./manifest.ts";
import { ClaudeTranslator } from "./translate.ts";

/** Tools available in `readOnly` access: reading, searching and the web. MCP tools stay available. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LSP", "WebFetch", "WebSearch", "ToolSearch"];

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/** Claude has no "minimal" effort; it runs as "low". */
const toClaudeEffort = (effort: ReasoningEffort): EffortLevel => (effort === "minimal" ? "low" : effort);

const toMcpConfig = (spec: McpServerSpec): McpServerConfig =>
  spec.type === "http"
    ? { type: "http", url: spec.url, ...(spec.headers ? { headers: { ...spec.headers } } : {}) }
    : {
        type: "stdio",
        command: spec.command,
        args: [...spec.args],
        ...(spec.env ? { env: { ...spec.env } } : {}),
      };

const toSdkOptions = (executablePath: string, options: SessionOptions, canUseTool: CanUseTool): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  cwd: options.cwd,
  model: options.model,
  ...(options.effort ? { effort: toClaudeEffort(options.effort) } : {}),
  ...(options.resume ? { resume: options.resume } : {}),
  includePartialMessages: true,
  // Load the user's own Claude configuration (CLAUDE.md, settings, skills) like their CLI does.
  settingSources: ["user", "project", "local"],
  disallowedTools: [...NATIVE_SUBAGENT_TOOLS],
  // `mcp__<server>` allows every tool of that server without a permission prompt.
  allowedTools: (options.trustedMcpServers ?? []).map((name) => `mcp__${name}`),
  ...(options.access === "readOnly" ? { tools: READ_ONLY_TOOLS } : {}),
  permissionMode: options.access === "acceptEdits" ? "acceptEdits" : "default",
  mcpServers: Object.fromEntries(
    Object.entries(options.mcpServers).map(([name, spec]) => [name, toMcpConfig(spec)]),
  ),
  strictMcpConfig: !options.includeUserMcpServers,
  ...(options.appendSystemPrompt
    ? { systemPrompt: { type: "preset", preset: "claude_code", append: options.appendSystemPrompt } }
    : {}),
  canUseTool,
});

const toPermissionResult = (
  decision: PermissionDecision,
  toolInput: Record<string, unknown>,
  suggestions: Parameters<CanUseTool>[2],
): PermissionResult => {
  if (decision.decision === "deny") {
    return { behavior: "deny", message: decision.message ?? "Denied by the user in Cerium." };
  }
  const remember =
    decision.scope === "session" && suggestions.suppressAlwaysAllowRule !== true && suggestions.suggestions;
  return {
    behavior: "allow",
    updatedInput: toolInput,
    ...(remember ? { updatedPermissions: remember } : {}),
  };
};

/**
 * Starts a Claude Code session on the user's installed `claude` in streaming-input mode. The session
 * lives until the enclosing scope closes. `events` is single-consumer.
 */
export const startClaudeSession = Effect.fn("ClaudeAdapter.startSession")(function* (
  executablePath: string,
  options: SessionOptions,
) {
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);

  const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
  const sideEvents = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const pendingPermissions = new Map<string, Deferred.Deferred<PermissionDecision>>();

  const awaitDecision = (requestId: string, signal: AbortSignal) =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<PermissionDecision>();
      pendingPermissions.set(requestId, decision);
      const aborted = Effect.callback<PermissionDecision>((resume) => {
        const onAbort = () => resume(Effect.succeed({ decision: "deny", scope: "once" }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      });
      return yield* Effect.raceFirst(Deferred.await(decision), aborted);
    }).pipe(Effect.ensuring(Effect.sync(() => pendingPermissions.delete(requestId))));

  const canUseTool: CanUseTool = (toolName, toolInput, details) =>
    run(
      Effect.gen(function* () {
        const requestId = details.toolUseID;
        yield* Queue.offer(sideEvents, {
          payload: {
            _tag: "PermissionRequested",
            requestId,
            toolName,
            summary:
              details.title ??
              [details.displayName ?? toolName, details.description].filter(Boolean).join(": "),
            input: toolInput,
          },
          raw: { toolName, input: toolInput, title: details.title, decisionReason: details.decisionReason },
        });
        const decision = yield* awaitDecision(requestId, details.signal);
        yield* Queue.offer(sideEvents, {
          payload: {
            _tag: "PermissionResolved",
            requestId,
            decision: decision.decision,
            scope: decision.scope,
          },
        });
        return toPermissionResult(decision, toolInput, details);
      }),
    );

  const session = query({
    prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
    options: toSdkOptions(executablePath, options, canUseTool),
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Queue.end(input);
      yield* Effect.sync(() => session.close());
    }),
  );

  const translator = new ClaudeTranslator();
  const sdkEvents = Stream.fromAsyncIterable(session, failure("The Claude session stream failed")).pipe(
    Stream.flatMap((message) => Stream.fromIterable(translator.translate(message))),
    Stream.ensuring(Queue.end(sideEvents)),
  );

  const control = <A>(message: string, call: () => Promise<A>) =>
    Effect.tryPromise({ try: call, catch: failure(message) }).pipe(Effect.asVoid);

  return {
    events: Stream.merge(sdkEvents, Stream.fromQueue(sideEvents), { haltStrategy: "left" }),
    send: (text) =>
      Queue.offer(input, {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      }).pipe(Effect.asVoid),
    respondToPermission: (requestId, decision) =>
      Effect.suspend(() => {
        const pending = pendingPermissions.get(requestId);
        return pending === undefined ? Effect.void : Deferred.succeed(pending, decision).pipe(Effect.asVoid);
      }),
    interrupt: control("Could not interrupt the Claude session", () => session.interrupt()),
    setModel: (model) => control("Could not switch the Claude model", () => session.setModel(model)),
    setEffort: (effort) =>
      control("Could not change Claude's effort", () =>
        session.applyFlagSettings({ effortLevel: toClaudeEffort(effort) }),
      ),
  } satisfies AgentSession;
});
