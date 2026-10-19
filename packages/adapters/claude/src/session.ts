import {
  query,
  type CanUseTool,
  type EffortLevel,
  type McpServerConfig,
  type Options,
  type PermissionMode,
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
  type TurnExtras,
} from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Effect, Queue, Stream } from "effect";

import { NATIVE_QUESTION_TOOLS, NATIVE_SUBAGENT_TOOLS, TODO_TOOLS, TODO_TOOLS_ENV } from "./manifest.ts";
import { ClaudeTranslator } from "./translate.ts";

/**
 * Tools available in `readOnly` access: reading, searching, the web, and the todo list, which only
 * keeps the agent's own notes. MCP tools stay available.
 */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LSP", "WebFetch", "WebSearch", "ToolSearch", ...TODO_TOOLS];

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

/** Claude Code's own permission mode for each access; `readOnly` and `ask` differ only in their tools. */
const permissionMode = (access: AccessMode): PermissionMode => {
  switch (access) {
    case "readOnly":
    case "ask":
      return "default";
    case "acceptEdits":
      return "acceptEdits";
    // Claude Code's classifier decides, and asks through `canUseTool` when it cannot. On a model or
    // account without auto mode, Claude Code runs it as `default`.
    case "auto":
      return "auto";
    case "fullAccess":
      return "bypassPermissions";
  }
};

export const toSdkOptions = (
  executablePath: string,
  options: SessionOptions,
  canUseTool: CanUseTool,
): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  cwd: options.cwd,
  model: options.model,
  ...(options.effort ? { effort: toClaudeEffort(options.effort) } : {}),
  ...(options.resume ? { resume: options.resume } : {}),
  includePartialMessages: true,
  // Load the user's own Claude configuration (CLAUDE.md, settings, skills) like their CLI does.
  settingSources: ["user", "project", "local"],
  disallowedTools: [...NATIVE_SUBAGENT_TOOLS, ...NATIVE_QUESTION_TOOLS],
  // Newer models get no todo tools unless asked; Cerium shows the list they keep.
  env: { ...process.env, ...TODO_TOOLS_ENV },
  ...(options.access === "readOnly" ? { tools: READ_ONLY_TOOLS } : {}),
  permissionMode: permissionMode(options.access),
  // The SDK refuses `bypassPermissions` without this explicit opt-in, and never consults `canUseTool`
  // under it (passing one makes it warn).
  ...(options.access === "fullAccess" ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
  mcpServers: Object.fromEntries(
    Object.entries(options.mcpServers).map(([name, spec]) => [name, toMcpConfig(spec)]),
  ),
  strictMcpConfig: !options.includeUserMcpServers,
  ...(options.appendSystemPrompt
    ? { systemPrompt: { type: "preset", preset: "claude_code", append: options.appendSystemPrompt } }
    : {}),
});

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A user turn's content: plain text, or the images first and then the text, as Anthropic advises. */
const toUserContent = (
  text: string,
  extras: TurnExtras | undefined,
): SDKUserMessage["message"]["content"] => {
  const images = extras?.images ?? [];
  if (images.length === 0) return text;
  return [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType as ImageMediaType, data: image.data },
    })),
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
  ];
};

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

  const awaitDecision = (
    requestId: string,
    decision: Deferred.Deferred<PermissionDecision>,
    signal: AbortSignal,
  ) =>
    Effect.gen(function* () {
      const aborted = Effect.callback<PermissionDecision>((resume) => {
        const onAbort = () => resume(Effect.succeed({ decision: "deny", scope: "once" }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      });
      return yield* Effect.raceFirst(Deferred.await(decision), aborted);
    }).pipe(Effect.ensuring(Effect.sync(() => pendingPermissions.delete(requestId))));

  // Trusted servers' tools (Cerium's own bus) are allowed here rather than through `allowedTools`, which
  // would bypass this callback for the whole server.
  const trustedPrefixes = (options.trustedMcpServers ?? []).map((name) => `mcp__${name}__`);
  const isTrusted = (toolName: string) => trustedPrefixes.some((prefix) => toolName.startsWith(prefix));

  const canUseTool: CanUseTool = (toolName, toolInput, details) =>
    run(
      Effect.gen(function* () {
        if (isTrusted(toolName))
          return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
        const requestId = details.toolUseID;
        // Registered before the request is announced: the orchestrator may answer it at once.
        const pending = yield* Deferred.make<PermissionDecision>();
        pendingPermissions.set(requestId, pending);
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
        const decision = yield* awaitDecision(requestId, pending, details.signal);
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
    send: (text, extras) =>
      Queue.offer(input, {
        type: "user",
        message: { role: "user", content: toUserContent(text, extras) },
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
