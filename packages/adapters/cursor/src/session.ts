import {
  Agent,
  CursorSdkError,
  getDefaultSdkStateRoot,
  JsonlLocalAgentStore,
  NetworkError,
  RateLimitError,
  type AgentOptions,
  type LocalAgentOptions,
  type McpServerConfig,
  type ModelListItem,
  type ModelSelection,
  type Run,
  type SDKUserMessage,
  type SendOptions,
  type SettingSource,
} from "@cursor/sdk";
import {
  HarnessFailure,
  type AdapterEvent,
  type AgentSession,
  type McpServerSpec,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { AccessMode, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Cause, Data, Effect, Queue, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { NATIVE_QUESTION_TOOLS, NATIVE_SUBAGENT_TOOLS } from "./manifest.ts";
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

/** A turn's message: the text, with any images as base64. */
const toUserMessage = (text: string, extras: TurnExtras | undefined): string | SDKUserMessage => {
  const images = extras?.images ?? [];
  return images.length === 0
    ? text
    : { text, images: images.map((image) => ({ data: image.data, mimeType: image.mediaType })) };
};

/** Command tools: `shell` (with its stdin writes) and the alternative `piBash` toolset's equivalent. */
const COMMAND_TOOLS = ["shell", "piBash"];

/**
 * Local runs execute every tool call without asking, and Cursor's hooks load only from files in the
 * user's repo or home, so nothing that needs an approval is offered: `ask` runs read-only and
 * `acceptEdits` edits without commands. `auto` and `fullAccess` have every tool. The SDK sends both
 * lists with every request; deny wins.
 */
export const toolRestrictions = (access: AccessMode): Pick<AgentOptions, "tools" | "disallowedTools"> => {
  const withheld = [...NATIVE_SUBAGENT_TOOLS, ...NATIVE_QUESTION_TOOLS];
  switch (access) {
    case "readOnly":
    case "ask":
      return { tools: [...READ_ONLY_TOOLS], disallowedTools: withheld };
    case "acceptEdits":
      return { disallowedTools: [...withheld, ...COMMAND_TOOLS] };
    case "auto":
    case "fullAccess":
      return { disallowedTools: withheld };
  }
};

/**
 * `auto` is Cursor's own Auto-review: its classifier approves or refuses each tool call. `fullAccess`
 * turns Cursor's sandbox off; other modes keep the user's own sandbox setting.
 */
export const accessOptions = (
  access: AccessMode,
): Pick<LocalAgentOptions, "sandboxOptions" | "autoReview"> => {
  switch (access) {
    case "readOnly":
    case "ask":
    case "acceptEdits":
      return {};
    case "auto":
      return { autoReview: true };
    case "fullAccess":
      return { sandboxOptions: { enabled: false } };
  }
};

/**
 * The user's own configuration (rules, skills, hooks), as their CLI loads it. Cursor also reads Claude
 * Code's settings files for hooks under these sources. Their MCP servers only reach the agent when the
 * user's own servers are included (see `mcpServers` below).
 */
const SETTING_SOURCES: Array<SettingSource> = ["project", "user"];

/** Windows' classic path limit, which SQLite's files must fit in unless long paths are enabled. */
const MAX_PATH = 259;
/** The longest file the SDK's default store keeps under its state root: an agent's SQLite journal. */
const LONGEST_STORE_FILE = `\\agents\\agent-${"0".repeat(64)}\\store.db-journal`.length;

/**
 * Where the SDK keeps the workspace's agents. By default that is SQLite under a folder named after the
 * workspace; on Windows a long workspace path puts its files past 260 characters, SQLite cannot write
 * them, the conversation is never saved and the run never finishes (Cursor's service replays its
 * turn every half minute). Those workspaces keep their agents in JSONL files beside the default
 * folder instead, which Node writes at any length. The choice depends on the path alone, so a resumed
 * agent is found where it was created.
 */
export const localStoreFor = (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Pick<LocalAgentOptions, "store"> => {
  if (platform !== "win32") return {};
  const root = getDefaultSdkStateRoot(cwd);
  return root.length + LONGEST_STORE_FILE <= MAX_PATH
    ? {}
    : { store: new JsonlLocalAgentStore(`${root}-jsonl`) };
};

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

/** How long a run may go on after its turn ended before the session cancels it (see `runTurn`). */
const TURN_GRACE_MS = 15_000;

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
  let speed: ModelSpeed | undefined = options.speed;
  let selection: ModelSelection = toModelSelection(model, effort, yield* catalog, speed);

  // Inline servers are not stored with the agent, so every session passes them again. Servers passed
  // per send replace every other source for that run, which keeps the user's own servers out.
  const mcpServers = Object.fromEntries(
    Object.entries(options.mcpServers).map(([name, spec]) => [name, toMcpConfig(spec)]),
  );
  // Every MCP call runs without a prompt (local runs never ask), which covers `trustedMcpServers`.
  const agentOptions: AgentOptions = {
    model: selection,
    local: {
      cwd: resolve(options.cwd),
      settingSources: SETTING_SOURCES,
      ...accessOptions(options.access),
      ...localStoreFor(resolve(options.cwd)),
    },
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

  const runTurn = ({ text, extras }: { readonly text: string; readonly extras?: TurnExtras }) =>
    Effect.gen(function* () {
      const turn = randomUUID();
      const prompt =
        instructionsDelivered || options.appendSystemPrompt === undefined
          ? text
          : withInstructions(options.appendSystemPrompt, text);
      // `run.wait()` settles moments after `turn-ended`. When the SDK cannot save the conversation it
      // never does, and half a minute later Cursor's service replays the whole turn, commands included
      // (see `localStoreFor`). So a run still going `TURN_GRACE` after its turn ended is cancelled, the
      // turn ends there, and any replayed updates are dropped.
      let ended = false;
      let markEnded = () => {};
      const turnEnded = new Promise<"turnEnded">((resolve) => {
        markEnded = () => setTimeout(() => resolve("turnEnded"), TURN_GRACE_MS).unref();
      });
      const sendOptions: SendOptions = {
        model: selection,
        ...(options.includeUserMcpServers ? {} : { mcpServers }),
        onDelta: ({ update }) => {
          if (ended) return;
          emit({ type: "update", turn, update });
          if (update.type === "turn-ended") {
            ended = true;
            markEnded();
          }
        },
      };
      const record = yield* Effect.tryPromise({
        try: () => agent.send(toUserMessage(prompt, extras), sendOptions),
        catch: (cause) => new SendFailed({ cause }),
      }).pipe(
        Effect.tap((run) => {
          current = run;
          return interruptRequested ? cancel(run).pipe(Effect.ignore) : Effect.void;
        }),
        Effect.flatMap((run) =>
          Effect.tryPromise({
            try: () => Promise.race([run.wait(), turnEnded]),
            catch: (cause) => new SendFailed({ cause }),
          }).pipe(
            Effect.flatMap((outcome) =>
              outcome === "turnEnded"
                ? cancel(run).pipe(
                    Effect.ignore,
                    Effect.timeoutOption("5 seconds"),
                    Effect.as<CursorRecord>({ type: "turnEnded", turn }),
                  )
                : Effect.succeed<CursorRecord>({ type: "result", turn, result: outcome }),
            ),
          ),
        ),
        Effect.catchTag("SendFailed", ({ cause }) =>
          Effect.succeed<CursorRecord>({ type: "sendFailed", turn, error: toCursorError(cause) }),
        ),
      );
      current = undefined;
      interruptRequested = false;
      pending--;
      // A failed run may never have reached the model; the instructions ride along again next turn.
      if (record.type === "turnEnded" || (record.type === "result" && record.result.status !== "error")) {
        instructionsDelivered = true;
      }
      emit(record);
    });

  const input = yield* Queue.unbounded<{ readonly text: string; readonly extras?: TurnExtras }>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(input).pipe(Effect.flatMap(runTurn))));

  const reselect = (next: {
    readonly model?: string;
    readonly effort?: ReasoningEffort;
    readonly speed?: ModelSpeed;
  }) =>
    catalog.pipe(
      Effect.map((models) => {
        model = next.model ?? model;
        effort = next.effort ?? effort;
        speed = next.speed ?? speed;
        selection = toModelSelection(model, effort, models, speed);
      }),
    );

  return {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      Effect.sync(() => pending++).pipe(
        Effect.andThen(Queue.offer(input, { text, ...(extras ? { extras } : {}) })),
        Effect.asVoid,
      ),
    // Nothing is ever asked (see `toolRestrictions`), so there is no request to answer.
    respondToPermission: () => Effect.void,
    interrupt: Effect.suspend(() => {
      if (current !== undefined) return cancel(current);
      if (pending > 0) interruptRequested = true;
      return Effect.void;
    }),
    // Each applies from the next turn: each `send()` carries the current selection.
    setModel: (next) => reselect({ model: next }),
    setEffort: (next) => reselect({ effort: next }),
    setSpeed: (next) => reselect({ speed: next }),
  } satisfies AgentSession;
});
