import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Cause, Effect, Queue, Stream } from "effect";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/**
 * Asks the user's `claude` which models it offers. Claude Code only answers inside a session, so this
 * opens one that is never sent a prompt and isn't saved, and closes it once the list arrives.
 */
export const listClaudeModels = Effect.fn("ClaudeAdapter.listModels")(function* (executablePath: string) {
  const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
  const models = yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      query({
        prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
        options: {
          pathToClaudeCodeExecutable: executablePath,
          persistSession: false,
          settingSources: ["user", "project", "local"],
        },
      }),
    ),
    (session) =>
      Effect.tryPromise({
        try: () => session.supportedModels(),
        catch: failure("Could not list Claude models"),
      }),
    (session) => Queue.end(input).pipe(Effect.andThen(Effect.sync(() => session.close()))),
  );
  // The "default" row is an alias for another row; it marks that row instead of being listed itself.
  const listed = models.filter((model) => model.value !== DEFAULT_ROW);
  const fallback = models.find((model) => model.value === DEFAULT_ROW)?.resolvedModel;
  const defaultId =
    fallback === undefined ? undefined : listed.find((model) => model.resolvedModel === fallback)?.value;
  return listed.map((model): ModelInfo => ({
    provider: "claude",
    id: model.value,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts: model.supportsEffort === true ? [...(model.supportedEffortLevels ?? [])] : [],
    ...(model.value === defaultId ? { isDefault: true } : {}),
  }));
});

const DEFAULT_ROW = "default";
