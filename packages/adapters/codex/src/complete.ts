import { HarnessFailure, type CompletionRequest, type CompletionUsage } from "@cerium/harness";
import { Effect, Stream } from "effect";

import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage.ts";
import { listAllModels } from "./models.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import { connect, type AppServer, type Incoming } from "./rpc.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/** Codex's efforts, lowest first, including the ones Cerium has no name for. */
const EFFORTS_LOWEST_FIRST = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The lowest effort a model takes, or none to leave Codex's default. */
export const lowestEffort = (supported: ReadonlyArray<string>) =>
  EFFORTS_LOWEST_FIRST.find((effort) => supported.includes(effort));

/**
 * What keeps a thread to answering: no browser, computer use, image generation, MCP servers, apps,
 * plugins or subagents to start or describe, none of the user's hooks or `notify` program. `shell` is
 * whether it keeps the shell tool, which a side question reads files with.
 */
export const answeringConfig = (userMcpServers: ReadonlyArray<string>, shell: boolean) =>
  ({
    agents: { enabled: false },
    features: {
      multi_agent: false,
      multi_agent_v2: false,
      apps: false,
      plugins: false,
      shell_tool: shell,
      shell_snapshot: false,
      browser_use: false,
      computer_use: false,
      image_generation: false,
      hooks: false,
    },
    notify: [],
    mcp_servers: Object.fromEntries(userMcpServers.map((name) => [name, { enabled: false }])),
    web_search: "disabled",
  }) satisfies Record<string, JsonValue>;

/**
 * A thread that only answers: nothing saved, the request's instructions in place of Codex's base
 * instructions (the long coding-agent prompt), no shell or web search, and the shortest answers and
 * reasoning the model gives. Codex still takes about two seconds to set each new thread's first turn
 * up, warm process or not.
 */
export const completionParams = (
  request: CompletionRequest,
  userMcpServers: ReadonlyArray<string>,
  effort: string | undefined,
) =>
  ({
    model: request.model,
    cwd: request.cwd,
    ephemeral: true,
    baseInstructions: request.instructions,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      ...answeringConfig(userMcpServers, false),
      model_reasoning_summary: "none",
      model_verbosity: "low",
      ...(effort === undefined ? {} : { model_reasoning_effort: effort }),
    } satisfies Record<string, JsonValue>,
  }) satisfies ThreadStartParams;

/** What a completion's turn has said so far. */
interface Reply {
  readonly text?: string;
  readonly error?: string;
}

/** Asks the user's `codex` one question on its own app-server, and resolves with the answer. */
export const completeWithCodex = Effect.fn("CodexAdapter.complete")(function* (
  executablePath: string,
  request: CompletionRequest,
) {
  const server = yield* connect(executablePath, request.cwd);
  // Both are read from the user's local config and Codex's model cache, so they cost little.
  const [{ config }, models] = yield* Effect.all(
    [server.request("config/read", { cwd: request.cwd }), listAllModels(server, true)],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(failure("Could not prepare a Codex thread")));
  const userMcpServers = Object.keys(
    (config as { readonly mcp_servers?: Record<string, unknown> | null }).mcp_servers ?? {},
  );
  const supported = models
    .find((model) => model.model === request.model)
    ?.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  const { thread } = yield* server
    .request("thread/start", completionParams(request, userMcpServers, lowestEffort(supported ?? [])))
    .pipe(Effect.mapError(failure("Could not start a Codex thread")));
  return yield* answerOn(server, thread.id, request.prompt, request.onUsage);
}, Effect.scoped);

/** Puts a prompt to a thread that only answers, and resolves with its reply. */
export const answerOn = Effect.fn("CodexAdapter.answerOn")(function* (
  server: AppServer,
  threadId: string,
  prompt: string,
  onUsage?: (usage: CompletionUsage) => void,
) {
  yield* server
    .request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] })
    .pipe(Effect.mapError(failure("Could not start a Codex turn")));

  const isEnd = (incoming: Incoming) =>
    incoming._tag === "Notification" &&
    incoming.message.method === "turn/completed" &&
    incoming.message.params.threadId === threadId;
  let first: ThreadTokenUsage | undefined;
  let latest: ThreadTokenUsage | undefined;
  const reply = yield* server.incoming.pipe(
    Stream.takeUntil(isEnd),
    Stream.runFoldEffect(
      (): Reply => ({}),
      (current, incoming) => {
        // Nothing here asks for approval; refusing anything that does keeps the turn from waiting.
        if (incoming._tag === "Request") {
          return server
            .respondError(incoming.message.id, -32000, "This thread takes no requests.")
            .pipe(Effect.as(current));
        }
        const { message } = incoming;
        if (message.method === "thread/tokenUsage/updated" && message.params.threadId === threadId) {
          first ??= message.params.tokenUsage;
          latest = message.params.tokenUsage;
        }
        if (message.method === "item/completed" && message.params.item.type === "agentMessage") {
          return Effect.succeed({ ...current, text: message.params.item.text });
        }
        if (message.method === "turn/completed" && message.params.turn.error !== null) {
          return Effect.succeed({ ...current, error: message.params.turn.error.message });
        }
        return Effect.succeed(current);
      },
    ),
  );
  if (first !== undefined && latest !== undefined) {
    const initial = first;
    const final = latest;
    const delta = (key: "inputTokens" | "cachedInputTokens" | "outputTokens") =>
      Math.max(0, final.total[key] - (initial.total[key] - initial.last[key]));
    const cachedInputTokens = delta("cachedInputTokens");
    onUsage?.({
      inputTokens: Math.max(0, delta("inputTokens") - cachedInputTokens),
      outputTokens: delta("outputTokens"),
      cachedInputTokens,
    });
  }
  if (reply.text !== undefined && reply.text.trim() !== "") return reply.text;
  return yield* new HarnessFailure({
    provider: "codex",
    message: reply.error ?? "Codex ended its turn without an answer",
    cause: reply,
  });
});
