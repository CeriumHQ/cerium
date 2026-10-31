import {
  describeByKind,
  type AcpConnection,
  mcpToolName,
  type AcpHarness,
  type AcpLaunch,
  type AcpSignIn,
  type DescribedTool,
  type InitializeResponse,
  type PromptResponse,
  type ToolCallState,
  type TurnTotals,
} from "@cerium/adapter-acp";
import { Effect } from "effect";

import { readUserMcpServers } from "./config.ts";
import { grokManifest, LOGIN_COMMAND } from "./manifest.ts";

// How Grok Build's ACP agent lines up with Cerium. Grok-specific behaviour, all from its source:
// - `rules` on `initialize`'s `_meta` append to its system prompt; `systemPromptOverride` replaces it.
// - `yoloMode` / `autoMode` on `session/new`'s `_meta` set the session's approval mode over the user's own.
// - The client signs it in with `authenticate`, using the `defaultAuthMethodId` its `initialize` names.
// - The client, not the agent, loads the user's MCP servers from config.toml.
// - Extension methods (`_x.ai/…`) fork, compact, delete, answer aside and read billing.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Calls one of Grok's extension methods. Grok 1.0.70 wraps each answer as `{"result": …}` (seen live);
 * an answer without the wrapper is taken as it is.
 */
export const grokExtension = <A>(
  connection: AcpConnection,
  method: string,
  params: Record<string, unknown>,
) =>
  connection.request<unknown>(`_x.ai/${method}`, params).pipe(
    Effect.map((answer): Partial<A> => {
      const inner =
        isRecord(answer) && Object.keys(answer).length === 1 && "result" in answer
          ? answer["result"]
          : answer;
      return (isRecord(inner) ? inner : {}) as Partial<A>;
    }),
  );

/** Auth methods that need the user at a browser (`grok.com` OAuth, enterprise `oidc`). */
const INTERACTIVE = new Set(["grok.com", "oidc"]);

/**
 * Grok's own choice of sign-in, as its headless client makes it: the default method its `initialize`
 * names, else a cached login, else the first offered. An interactive one means signed out.
 */
export const grokSignIn = (initialized: InitializeResponse): AcpSignIn => {
  const methods = (initialized.authMethods ?? []).map((method) => method.id);
  const preferred = stringOf(initialized._meta?.["defaultAuthMethodId"]);
  const chosen =
    (preferred !== undefined && methods.includes(preferred) ? preferred : undefined) ??
    methods.find((id) => id === "cached_token") ??
    methods[0];
  if (chosen === undefined) return { _tag: "Ready" };
  if (INTERACTIVE.has(chosen)) return { _tag: "SignedOut" };
  return { _tag: "Authenticate", methodId: chosen, meta: { headless: true } };
};

/** The account a sign-in method is, as Settings words it. */
export const grokAuthMethod = (initialized: InitializeResponse): string | undefined => {
  const signIn = grokSignIn(initialized);
  if (signIn._tag !== "Authenticate") return undefined;
  return signIn.methodId === "xai.api_key" ? "apiKey" : "grok.com";
};

/**
 * The environment of every Grok process Cerium starts: no subagents (Cerium's bus spawns agents), no
 * question tool (agents ask through `ask_user`), no self-update mid-session, and for Cerium's own short
 * jobs no memory. Read-only agent sessions run in Grok's `read-only` sandbox, which on Linux needs
 * bubblewrap (Grok refuses to start without it; the probe reports the setup). Cerium's own jobs answer
 * every request to write with a denial instead, so they run anywhere.
 */
export const grokEnvironment = (launch: Pick<AcpLaunch, "purpose" | "access">): Record<string, string> => ({
  GROK_SUBAGENTS: "0",
  GROK_ASK_USER_QUESTION: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
  ...(launch.purpose === "session" ? {} : { GROK_MEMORY: "0" }),
  ...(launch.access === "readOnly" && launch.purpose === "session" ? { GROK_SANDBOX: "read-only" } : {}),
});

/**
 * Grok's tool kinds (`_meta["x.ai/tool"].kind`) as the tool names Cerium's transcript knows. Kinds left
 * out keep Grok's own name.
 */
const TOOL_NAMES: Record<string, string> = {
  read: "read",
  edit: "edit",
  write: "write",
  delete: "delete",
  move: "move",
  list_dir: "ls",
  list: "ls",
  search: "grep",
  execute: "shell",
  web_search: "websearch",
  web_fetch: "webfetch",
  plan: "update_plan",
  skill: "Skill",
  task: "Task",
};

/** Grok's description of a call: `_meta["x.ai/tool"]`, with its name, kind and a canonical input. */
export const grokTool = (call: ToolCallState) => {
  const meta = isRecord(call.meta) ? call.meta["x.ai/tool"] : undefined;
  if (!isRecord(meta)) return undefined;
  return {
    name: stringOf(meta["name"]),
    kind: stringOf(meta["kind"]),
    namespace: stringOf(meta["namespace"]),
    input: isRecord(meta["input"]) ? meta["input"] : undefined,
  };
};

/**
 * A call as Cerium reports it. Grok names MCP tools `<server>__<tool>`; its built-ins by kind. The input
 * is the agent's raw input with Grok's canonical fields over it (`path`, `command`, `pattern`), and an
 * edit's before and after from its diff, which Grok sends as the replaced fragment, not the whole file.
 */
export const describeGrokTool = (call: ToolCallState, servers: ReadonlyArray<string>): DescribedTool => {
  const generic = describeByKind(call, servers);
  const own = grokTool(call);
  const name = own?.name ?? call.name;
  // A server Cerium didn't inject (the user's own) still reads as one when Grok files it under MCP.
  const mcp =
    mcpToolName(name, servers) ??
    (own?.namespace === "mcp" && name !== undefined && /^[^_].*?__.+/.test(name)
      ? `mcp__${name}`
      : undefined);
  if (mcp !== undefined) return { toolName: mcp, input: generic.input };
  const kind = own?.kind;
  const toolName = (kind === undefined ? undefined : TOOL_NAMES[kind]) ?? generic.toolName;
  const input = isRecord(generic.input) ? { ...generic.input, ...own?.input } : (own?.input ?? generic.input);
  // A Grok `write` is a whole new file; its diff's `newText` is the content.
  if (toolName === "write" && isRecord(input) && input["content"] === undefined) {
    const diff = call.content.find((item) => item.type === "diff");
    if (diff !== undefined && diff.type === "diff")
      return { toolName, input: { ...input, content: diff.newText } };
  }
  return { toolName, input };
};

/** Grok's tools Cerium never lets run: subagents, their messages and its own question tool. */
export const isWithheldGrokTool = (call: ToolCallState): boolean => {
  const kind = grokTool(call)?.kind;
  return kind === "task" || kind === "active_agent_message" || kind === "ask_user";
};

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** USD ticks per dollar in Grok's `costUsdTicks`. */
const TICKS_PER_USD = 1e10;

/**
 * A turn's spend from `_meta.usage`, which sums the whole prompt (its sibling fields describe only the
 * last model call). Its `inputTokens` include cache reads; cost is trusted only when Grok says it is
 * complete.
 */
export const grokTurnUsage = (response: PromptResponse): TurnTotals | undefined => {
  const usage = isRecord(response._meta) ? response._meta["usage"] : undefined;
  if (!isRecord(usage)) return undefined;
  const input = number(usage["inputTokens"]);
  const output = number(usage["outputTokens"]);
  const cached = number(usage["cachedReadTokens"]);
  const reasoning = number(usage["reasoningTokens"]);
  const total = number(usage["totalTokens"]);
  // Reasoning is output; where the total shows it isn't counted in `outputTokens` already, it is added.
  const reasoningApart = reasoning > 0 && total >= input + output + reasoning;
  const ticks = usage["costUsdTicks"];
  const trusted = usage["usageIsIncomplete"] !== true && usage["costIsPartial"] !== true;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output + (reasoningApart ? reasoning : 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(trusted && typeof ticks === "number" && ticks > 0 ? { costUsd: ticks / TICKS_PER_USD } : {}),
  };
};

/**
 * The `grok` command line: an ACP agent on stdio, always a process of its own (`--no-leader`), never
 * the shared leader the user's config may enable, whose environment and sandbox would not be Cerium's.
 */
export const grokArgs = (): ReadonlyArray<string> => ["agent", "--no-leader", "stdio"];

export const grokHarness: AcpHarness = {
  provider: "grok",
  name: "Grok Build",
  loginCommand: LOGIN_COMMAND,
  manifest: grokManifest,
  instructions: "launch",
  command: (launch) => {
    const instructions = launch.appendSystemPrompt?.trim();
    // Cerium's small jobs replace Grok's system prompt entirely; agents append to it.
    const prompt =
      instructions === undefined || instructions === ""
        ? {}
        : launch.purpose === "completion"
          ? { systemPromptOverride: instructions }
          : { rules: instructions };
    return {
      args: grokArgs(),
      env: grokEnvironment(launch),
      ...(Object.keys(prompt).length > 0 ? { initializeMeta: prompt } : {}),
      sessionMeta: { yoloMode: launch.access === "fullAccess", autoMode: launch.access === "auto" },
      userMcpServers: readUserMcpServers(launch.cwd).pipe(Effect.orElseSucceed(() => [])),
    };
  },
  describeTool: (call, servers) => describeGrokTool(call, servers),
  isWithheld: (call) => isWithheldGrokTool(call),
  signIn: (initialized) => grokSignIn(initialized),
  turnUsage: (response) => grokTurnUsage(response),
  // Grok's docs read the final text after the answer; a moment's grace catches what trails it.
  settleMillis: 100,
  compact: (connection, sessionId) =>
    grokExtension(connection, "compact_conversation", { sessionId }).pipe(Effect.asVoid),
  fork: (connection, request) =>
    grokExtension<{ readonly newSessionId: unknown }>(connection, "session/fork", {
      sourceSessionId: request.sessionId,
      sourceCwd: request.cwd,
      newCwd: request.cwd,
      ...(request.promptIndex === undefined ? {} : { targetPromptIndex: request.promptIndex }),
    }).pipe(
      Effect.flatMap((answer) =>
        typeof answer?.newSessionId === "string" && answer.newSessionId !== ""
          ? Effect.succeed(answer.newSessionId)
          : Effect.die(new Error("Grok Build's fork named no new session")),
      ),
    ),
  deleteSession: (connection, sessionId, cwd) =>
    grokExtension(connection, "session/delete", { sessionId, cwd }).pipe(Effect.asVoid),
  sideQuestion: (connection, sessionId, question) =>
    grokExtension<{ readonly answer: unknown }>(connection, "btw", { sessionId, question }).pipe(
      Effect.map((answer) => (typeof answer.answer === "string" ? answer.answer : "")),
    ),
};
