import { Agent, JsonlLocalAgentStore, type AgentOptions, type ModelListItem } from "@cursor/sdk";
import { HarnessFailure, type CompletionRequest } from "@cerium/harness";
import { Effect, FileSystem, Path } from "effect";

import { toModelSelection } from "./models.ts";
import { withInstructions } from "./session.ts";

/**
 * A text-only agent: no tools, none of the user's rules, skills or MCP servers, and the model's lowest
 * effort. Its store is a folder that goes when the answer is in, so it never joins the user's agents.
 * `systemPrompt` would replace Cursor's prompt, but it is gated per account and an account without it
 * waits 20 seconds for the refusal, so the instructions open the message instead.
 */
export const completionOptions = (
  request: CompletionRequest,
  catalog: ReadonlyArray<ModelListItem>,
  storeDirectory: string,
): AgentOptions => ({
  model: toModelSelection(request.model, "minimal", catalog),
  tools: [],
  local: { cwd: request.cwd, settingSources: [], store: new JsonlLocalAgentStore(storeDirectory) },
});

/** Asks a local Cursor agent one question and resolves with its answer. */
export const completeWithCursor = Effect.fn("CursorAdapter.complete")(function* (
  request: CompletionRequest,
  catalog: Effect.Effect<ReadonlyArray<ModelListItem>, HarnessFailure>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "cerium-cursor-" })
    .pipe(
      Effect.mapError((cause) => new HarnessFailure({ provider: "cursor", message: cause.message, cause })),
    );
  const options = completionOptions(request, yield* catalog, path.join(directory, "store"));
  const result = yield* Effect.tryPromise({
    try: () => Agent.prompt(withInstructions(request.instructions, request.prompt), options),
    catch: (cause) =>
      new HarnessFailure({
        provider: "cursor",
        message: `Cursor couldn't answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  if (result.usage !== undefined)
    request.onUsage?.({
      inputTokens: result.usage.inputTokens + result.usage.cacheWriteTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cacheReadTokens,
    });
  if (result.status === "finished" && result.result !== undefined && result.result.trim() !== "") {
    return result.result;
  }
  return yield* new HarnessFailure({
    provider: "cursor",
    message: `Cursor couldn't answer: ${result.error?.message ?? result.status}`,
    cause: result,
  });
}, Effect.scoped);
