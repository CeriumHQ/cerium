import {
  Agent,
  CursorSdkError,
  NetworkError,
  RateLimitError,
  type AgentOptions,
  type McpServerConfig,
  type ModelListItem,
  type ModelSelection,
  type Run,
  type SendOptions,
  type SettingSource,
} from "@cursor/sdk";
import {
  HarnessFailure,
  type AdapterEvent,
  type AgentSession,
  type McpServerSpec,
  type SessionOptions,
} from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
import { Cause, Data, Effect, Queue, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { NATIVE_SUBAGENT_TOOLS } from "./manifest.ts";
import { toModelSelection } from "./models.ts";
import { isUnauthenticated } from "./probe.ts";
import { CursorTranslator, type CursorError, type CursorRecord } from "./translate.ts";

/** Built-in tools for `readOnly` and `ask`: reading, searching, the web and MCP (Cerium's bus). */
export const READ_ONLY_TOOLS = [
  "read",
  "glob",
  "grep",
  "ls",
  "semSearch",
  "readLints",
  "webSearch",
  "webFetch",
  "mcp",
  "readTodos",
  "updateTodos",
];

/** Command tools: `shell` (with its stdin writes) and the alternative `piBash` toolset's equivalent. */
const COMMAND_TOOLS = ["shell", "piBash"];

/**
 * Local runs execute every tool call without asking, and Cursor's hooks load only from files in the
 * user's repo or home, so nothing that needs an approval is offered: `ask` runs read-only and
 * `acceptEdits` edits without commands. The SDK sends both lists with every request; deny wins.
 */
export const toolRestrictions = (access: AccessMode): Pick<AgentOptions, "tools" | "disallowedTools"> => {
  switch (access) {
    case "readOnly":
    case "ask":
      return { tools: [...READ_ONLY_TOOLS], disallowedTools: [...NATIVE_SUBAGENT_TOOLS] };
    case "acceptEdits":
      return { disallowedTools: [...NATIVE_SUBAGENT_TOOLS, ...COMMAND_TOOLS] };
  }
};

/**
 * The user's own configuration (rules, skills, hooks), as their CLI loads it. Cursor also reads Claude
 * Code's settings files for hooks under these sources. Their MCP servers only reach the agent when the
 * user's own servers are included (see `mcpServers` below).
 */
const SETTING_SOURCES: Array<SettingSource> = ["project", "user"];

const toMcpConfig = (spec: McpServerSpec): McpServerConfig =>
  spec.type === "http"
    ? { type: "http", url: spec.url, ...(spec.headers ? { headers: { ...spec.headers } } : {}) }
    : {
        type: "stdio",
        command: spec.command,
        args: [...spec.args],
        ...(spec.env ? { env: { ...spec.env } } : {}),
      };

/**
 * Cursor has no appendable system prompt (`systemPrompt` replaces Cursor's entirely and is gated per
 * account), so Cerium's instructions open the first turn, marked as coming from Cerium.
 */
export const withInstructions = (instructions: string, text: string) =>
  [
    "<cerium_instructions>",
    "Cerium, the app running this session, adds these instructions. Follow them like system instructions.",
    "",
    instructions,
    "</cerium_instructions>",
    "",
    text,
  ].join("\n");

/** Error class names are minified in the SDK bundle, so the kind comes from `instanceof`. */
const toCursorError = (cause: unknown): CursorError => {
  const kind = isUnauthenticated(cause)
    ? "auth"
    : cause instanceof RateLimitError
      ? "rateLimit"
      : cause instanceof NetworkError
        ? "network"
        : "other";
  const sdk = cause instanceof CursorSdkError ? cause : undefined;
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    kind,
    ...(sdk?.code ? { code: sdk.code } : {}),
    ...(sdk ? { isRetryable: sdk.isRetryable } : {}),
  };
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "cursor", message, cause });

/** `agent.send()` or `run.wait()` rejected; the turn ends with the error instead of failing the session. */
class SendFailed extends Data.TaggedError("SendFailed")<{ readonly cause: unknown }> {}

/**
 * Starts (or resumes) a local Cursor agent: the SDK runs the agent loop in this process and the model
 * on Cursor's servers. Turns run one at a time in `send` order, each ending in exactly one
 * `TurnCompleted`. The session lives until the enclosing scope closes. `events` is single-consumer.
 */
export const startCursorSession = Effect.fn("CursorAdapter.startSession")(function* (
  options: SessionOptions,
  catalog: Effect.Effect<ReadonlyArray<ModelListItem>, HarnessFailure>,
) {
  const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(events));
  const translator = new CursorTranslator();
  // SDK callbacks run outside any fiber; the queue is unbounded, so offering never waits.
  const emit = (record: CursorRecord) => {
    for (const event of translator.translate(record)) Queue.offerUnsafe(events, event);
  };

  let model = options.model;
  let effort: ReasoningEffort | undefined = options.effort;
  let selection: ModelSelection = toModelSelection(model, effort, yield* catalog);

  // Inline servers are not stored with the agent, so every session passes them again. Servers passed
  // per send replace every other source for that run, which keeps the user's own servers out.
  const mcpServers = Object.fromEntries(
    Object.entries(options.mcpServers).map(([name, spec]) => [name, toMcpConfig(spec)]),
  );
  // Every MCP call runs without a prompt (local runs never ask), which covers `trustedMcpServers`.
  const agentOptions: AgentOptions = {
    model: selection,
    local: { cwd: resolve(options.cwd), settingSources: SETTING_SOURCES },
    ...toolRestrictions(options.access),
    ...(options.includeUserMcpServers ? { mcpServers } : {}),
  };
  const agent = yield* Effect.tryPromise({
    try: () =>
      options.resume === undefined ? Agent.create(agentOptions) : Agent.resume(options.resume, agentOptions),
    catch: failure(
      options.resume === undefined ? "Could not start the Cursor agent" : "Could not resume the Cursor agent",
    ),
  });

  /** The run in flight, once `agent.send()` has returned it. */
  let current: Run | undefined;
  /** Sends not yet answered by their `TurnCompleted`, including ones waiting to start. */
  let pending = 0;
  /** An interrupt that arrived before the turn's run existed; it cancels the run as soon as it does. */
  let interruptRequested = false;
  let instructionsDelivered = options.resume !== undefined || options.appendSystemPrompt === undefined;

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.cancel().catch(() => undefined);
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }),
  );
  emit({ type: "agent", agentId: agent.agentId, model: selection });

  const cancel = (run: Run) =>
    Effect.tryPromise({ try: () => run.cancel(), catch: failure("Could not interrupt the Cursor run") });

  const runTurn = (text: string) =>
    Effect.gen(function* () {
      const turn = randomUUID();
      const prompt =
        instructionsDelivered || options.appendSystemPrompt === undefined
          ? text
          : withInstructions(options.appendSystemPrompt, text);
      const sendOptions: SendOptions = {
        model: selection,
        ...(options.includeUserMcpServers ? {} : { mcpServers }),
        onDelta: ({ update }) => emit({ type: "update", turn, update }),
      };
      const record = yield* Effect.tryPromise({
        try: () => agent.send(prompt, sendOptions),
        catch: (cause) => new SendFailed({ cause }),
      }).pipe(
        Effect.tap((run) => {
          current = run;
          return interruptRequested ? cancel(run).pipe(Effect.ignore) : Effect.void;
        }),
        Effect.flatMap((run) =>
          Effect.tryPromise({ try: () => run.wait(), catch: (cause) => new SendFailed({ cause }) }),
        ),
        Effect.map((result): CursorRecord => ({ type: "result", turn, result })),
        Effect.catchTag("SendFailed", ({ cause }) =>
          Effect.succeed<CursorRecord>({ type: "sendFailed", turn, error: toCursorError(cause) }),
        ),
      );
      current = undefined;
      interruptRequested = false;
      pending--;
      // A failed run may never have reached the model; the instructions ride along again next turn.
      if (record.type === "result" && record.result.status !== "error") instructionsDelivered = true;
      emit(record);
    });

  const input = yield* Queue.unbounded<string>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(input).pipe(Effect.flatMap(runTurn))));

  const reselect = (next: { readonly model?: string; readonly effort?: ReasoningEffort }) =>
    catalog.pipe(
      Effect.map((models) => {
        model = next.model ?? model;
        effort = next.effort ?? effort;
        selection = toModelSelection(model, effort, models);
      }),
    );

  return {
    events: Stream.fromQueue(events),
    send: (text) =>
      Effect.sync(() => pending++).pipe(Effect.andThen(Queue.offer(input, text)), Effect.asVoid),
    // Nothing is ever asked (see `toolRestrictions`), so there is no request to answer.
    respondToPermission: () => Effect.void,
    interrupt: Effect.suspend(() => {
      if (current !== undefined) return cancel(current);
      if (pending > 0) interruptRequested = true;
      return Effect.void;
    }),
    // Both apply from the next turn: each `send()` carries the current selection.
    setModel: (next) => reselect({ model: next }),
    setEffort: (next) => reselect({ effort: next }),
  } satisfies AgentSession;
});
