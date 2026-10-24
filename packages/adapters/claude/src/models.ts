import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Cause, Effect, Queue, Stream } from "effect";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/**
 * The session `inspectClaude` asks. Without a `cwd` it is asked about the account (its models, its
 * usage), which needs none of the user's MCP servers: Claude Code would otherwise start each of them
 * for the question.
 */
export const inspectOptions = (executablePath: string, cwd: string | undefined): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  ...(cwd === undefined ? { mcpServers: {}, strictMcpConfig: true } : { cwd }),
  persistSession: false,
  settingSources: ["user", "project", "local"],
});

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
          options: inspectOptions(executablePath, cwd),
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
    ...(CACHE_SAFE_EFFORT.has(model.resolvedModel ?? model.value) ? { cacheSafeEffort: true } : {}),
    ...(model.value === defaultId ? { isDefault: true } : {}),
  }));
});

const DEFAULT_ROW = "default";

/**
 * The models whose prompt cache survived `applyFlagSettings({ effortLevel })` in a live check
 * (Claude Code 2.1.309, medium → low). Opus 5, Sonnet 5 and Sonnet 4.6 started the cache over, Opus 5
 * despite Anthropic listing it for per-message effort.
 */
const CACHE_SAFE_EFFORT: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
]);
