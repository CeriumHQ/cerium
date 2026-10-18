import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Cause, Effect, Queue, Stream } from "effect";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/**
 * Asks the user's `claude` something only a session answers. The session is never sent a prompt and
 * isn't saved, and closes once `use` settles.
 */
export const inspectClaude = <A>(
  executablePath: string,
  cwd: string | undefined,
  message: string,
  use: (session: Query) => Promise<A>,
) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        query({
          prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
          options: {
            pathToClaudeCodeExecutable: executablePath,
            ...(cwd === undefined ? {} : { cwd }),
            persistSession: false,
            settingSources: ["user", "project", "local"],
          },
        }),
      ),
      (session) => Effect.tryPromise({ try: () => use(session), catch: failure(message) }),
      (session) => Queue.end(input).pipe(Effect.andThen(Effect.sync(() => session.close()))),
    );
  });

/** Asks the user's `claude` which models it offers. */
export const listClaudeModels = Effect.fn("ClaudeAdapter.listModels")(function* (executablePath: string) {
  const models = yield* inspectClaude(executablePath, undefined, "Could not list Claude models", (session) =>
    session.supportedModels(),
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
