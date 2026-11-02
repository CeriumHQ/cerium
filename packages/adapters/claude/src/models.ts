import {
  query,
  type FastModeDisabledReason,
  type ModelInfo as SdkModelInfo,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Cause, Effect, Queue, Stream } from "effect";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/**
 * The session `inspectClaude` asks. Without a `cwd` it is asked about the account (its models, its
 * usage), which needs none of the user's MCP servers: Claude Code would otherwise start each of them
 * for the question. It opts in to fast mode, which an SDK session must, so it says whether the account
 * may use it.
 */
export const inspectOptions = (executablePath: string, cwd: string | undefined): Options => ({
  pathToClaudeCodeExecutable: executablePath,
  ...(cwd === undefined ? { mcpServers: {}, strictMcpConfig: true, settings: { fastMode: true } } : { cwd }),
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

/**
 * Why Claude Code says the account can't use fast mode, for the reasons that hold for every model:
 * no paid plan, no usage credits, the organization or the environment turned it off, a provider other
 * than Anthropic's own, or the check failing, which runs requests at standard speed. Still checking,
 * and an allowlist that leaves out the default fast-mode model, don't keep it from the models.
 */
const FAST_MODE_BLOCKED: ReadonlySet<FastModeDisabledReason> = new Set([
  "free",
  "preference",
  "extra_usage_disabled",
  "network_error",
  "unknown",
  "not_first_party",
  "disabled_by_env",
]);

/**
 * Claude Code's model rows as Cerium lists them. `fastMode` is why the account can't use fast mode,
 * absent when it can: the models that support it then offer it, and run at standard speed unless a
 * session opts in.
 */
export const toModelInfos = (
  models: ReadonlyArray<SdkModelInfo>,
  fastMode: FastModeDisabledReason | undefined,
): ReadonlyArray<ModelInfo> => {
  // The "default" row is an alias for another row; it marks that row instead of being listed itself.
  const listed = models.filter((model) => model.value !== DEFAULT_ROW);
  const fallback = models.find((model) => model.value === DEFAULT_ROW)?.resolvedModel;
  const defaultId =
    fallback === undefined ? undefined : listed.find((model) => model.resolvedModel === fallback)?.value;
  const fast = fastMode === undefined || !FAST_MODE_BLOCKED.has(fastMode);
  return listed.map((model): ModelInfo => ({
    provider: "claude",
    id: model.value,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts: model.supportsEffort === true ? [...(model.supportedEffortLevels ?? [])] : [],
    ...(CACHE_SAFE_EFFORT.has(model.resolvedModel ?? model.value) ? { cacheSafeEffort: true } : {}),
    ...(fast && model.supportsFastMode === true
      ? { speeds: ["standard", "fast"], defaultSpeed: "standard" }
      : {}),
    ...(model.value === defaultId ? { isDefault: true } : {}),
  }));
};

/** Asks the user's `claude` which models it offers, and whether the account may run them fast. */
export const listClaudeModels = Effect.fn("ClaudeAdapter.listModels")(function* (executablePath: string) {
  const { models, fastMode } = yield* inspectClaude(
    executablePath,
    undefined,
    "Could not list Claude models",
    async (session) => {
      const [models, init] = await Promise.all([session.supportedModels(), session.initializationResult()]);
      return { models, fastMode: init.fast_mode_disabled_reason };
    },
  );
  return toModelInfos(models, fastMode);
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
