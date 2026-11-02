import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure, type CompletionRequest } from "@cerium/harness";
import { Effect } from "effect";

/**
 * The quickest answer the user's `claude` gives: the request's instructions in place of Claude Code's
 * own system prompt, no tools, MCP servers or settings to load, no thinking, and nothing saved. The
 * CLI also skips its update checks and telemetry, which halves its start.
 */
export const completionOptions = (
  executablePath: string,
  request: CompletionRequest,
  abortController: AbortController,
): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  cwd: request.cwd,
  model: request.model,
  systemPrompt: request.instructions,
  tools: [],
  settingSources: [],
  mcpServers: {},
  strictMcpConfig: true,
  persistSession: false,
  maxTurns: 1,
  thinking: { type: "disabled" },
  env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  abortController,
});

/** Asks the user's `claude` one question and resolves with its answer. */
export const completeWithClaude = Effect.fn("ClaudeAdapter.complete")(function* (
  executablePath: string,
  request: CompletionRequest,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const abortController = new AbortController();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
      for await (const message of query({
        prompt: request.prompt,
        options: completionOptions(executablePath, request, abortController),
      })) {
        if (message.type !== "result") continue;
        request.onUsage?.({
          inputTokens: message.usage.input_tokens + message.usage.cache_creation_input_tokens,
          outputTokens: message.usage.output_tokens,
          cachedInputTokens: message.usage.cache_read_input_tokens,
          costUsd: message.total_cost_usd,
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
