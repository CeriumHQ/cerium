import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure, type SideQuestionRequest } from "@cerium/harness";
import { Effect } from "effect";

/** What a side question may use: reading and searching the project, nothing that changes anything. */
const SIDE_TOOLS = ["Read", "Glob", "Grep"];

/** The most steps a side question takes to look things up before it must answer. */
const MAX_TURNS = 8;

/**
 * A fork of the session that is never written down: `forkSession` gives the copy an id of its own and
 * `persistSession: false` keeps it, and the question, off the user's disk and out of `claude --resume`.
 * It can only read, and a tool it isn't given is refused rather than asked about.
 */
export const sideQuestionOptions = (
  executablePath: string,
  request: SideQuestionRequest,
  abortController: AbortController,
): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  cwd: request.cwd,
  model: request.model,
  resume: request.sessionId,
  forkSession: true,
  persistSession: false,
  tools: SIDE_TOOLS,
  allowedTools: SIDE_TOOLS,
  permissionMode: "dontAsk",
  settingSources: [],
  mcpServers: {},
  strictMcpConfig: true,
  maxTurns: MAX_TURNS,
  systemPrompt: { type: "preset", preset: "claude_code", append: request.instructions },
  env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  abortController,
});

/** Asks a fork of a Claude Code session one question and resolves with its answer. */
export const askClaudeSideQuestion = Effect.fn("ClaudeAdapter.sideQuestion")(function* (
  executablePath: string,
  request: SideQuestionRequest,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const abortController = new AbortController();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
      for await (const message of query({
        prompt: request.prompt,
        options: sideQuestionOptions(executablePath, request, abortController),
      })) {
        if (message.type !== "result") continue;
        request.onUsage?.({
          inputTokens: message.usage.input_tokens + message.usage.cache_creation_input_tokens,
          outputTokens: message.usage.output_tokens,
          cachedInputTokens: message.usage.cache_read_input_tokens,
        });
        if (message.subtype === "success" && !message.is_error) return message.result;
        throw new Error(
          message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype,
        );
      }
      throw new Error("Claude Code ended without a result");
    },
    catch: (cause) =>
      new HarnessFailure({
        provider: "claude",
        message: `Claude couldn't answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
});
