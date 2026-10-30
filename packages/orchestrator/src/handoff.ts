import type { AgentId } from "@cerium/protocol";
import { HelperUsage } from "./helperUsage.ts";
import type {
  AgentEvent,
  AgentInfo,
  LeadHandedOff,
  ModelChoice,
  ProviderId,
  TodoItem,
} from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { renderTurn } from "./prompts.ts";
import { HANDOFF_PREFACE, isBrief } from "./rewind.ts";
import { Adapters, Catalog, offeredModels, OrchestratorConfig } from "./services.ts";
import { UserSettings } from "./settings.ts";
import { titleModels } from "./titles.ts";

// Handing a thread's lead to another harness. Nothing crosses between harnesses but conversation
// text: the new session is told the conversation so far with its first turn, the newest turns word
// for word and the older ones condensed by the quick model that titles threads, with the files the
// thread changed, its plan and the agents still at work.

/** Each harness by the name its makers give it, as the new session is told where it came from. */
const harnessName: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** How much of the conversation a handoff tells word for word, in characters (about 12k tokens). */
const VERBATIM_BUDGET = 48_000;
/** The most it quotes of one message. */
const VERBATIM_MESSAGE = 6_000;
/** The newest turns always told word for word, however long, before older ones are condensed. */
const MIN_VERBATIM_TURNS = 2;
/** How much of the older turns the quick model reads, newest kept. */
const CONDENSE_INPUT = 120_000;
/** Without a summary, the most of the older turns' requests the brief lists. */
const REQUESTS_BUDGET = 8_000;
/** The most files the brief names. */
const MAX_FILES = 150;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} […]`);

/** One turn of the conversation: what came in, and the agent's last message of it. */
export interface Exchange {
  readonly input: string;
  readonly reply?: string;
  /** The text of the user's own messages in it, for a brief without a summary. */
  readonly asked: ReadonlyArray<string>;
}

/**
 * The conversation's turns in a lead's live events (`liveEvents`). The briefs earlier handoffs and
 * replays told are the conversation before them, which these turns tell again, so they're left out.
 */
export const exchanges = (live: ReadonlyArray<AgentEvent>): ReadonlyArray<Exchange> => {
  const turns: Array<{ input: string; reply?: string; asked: ReadonlyArray<string> }> = [];
  for (const { payload } of live) {
    if (payload._tag === "TurnInput") {
      const items = payload.items.filter((item) => item._tag !== "SystemNotice" || !isBrief(item.text));
      turns.push({
        input: items.length === 0 ? "" : renderTurn(items),
        asked: items.flatMap((item) =>
          item._tag === "FromUser" && item.text.trim() !== "" ? [item.text] : [],
        ),
      });
    }
    const last = turns.at(-1);
    if (payload._tag === "MessageCompleted" && last !== undefined) last.reply = payload.text;
  }
  return turns.filter((turn) => turn.input !== "" || turn.reply !== undefined);
};

/** One turn as told word for word: what came in, and the agent's last message of it. */
export const entryOf = (turn: Exchange) =>
  [
    `[Input]\n${clip(turn.input, VERBATIM_MESSAGE)}`,
    ...(turn.reply === undefined ? [] : [`[You]\n${clip(turn.reply, VERBATIM_MESSAGE)}`]),
  ].join("\n\n");

/** How a conversation splits between the turns told word for word and the older ones condensed. */
export interface Split {
  readonly older: ReadonlyArray<Exchange>;
  readonly recent: ReadonlyArray<Exchange>;
}

/** The newest turns that fit the budget (at least `MIN_VERBATIM_TURNS`), and the older ones before them. */
export const splitConversation = (turns: ReadonlyArray<Exchange>, budget = VERBATIM_BUDGET): Split => {
  let used = 0;
  let from = turns.length;
  while (from > 0) {
    const size = entryOf(turns[from - 1]!).length;
    if (used + size > budget && turns.length - from >= MIN_VERBATIM_TURNS) break;
    used += size;
    from--;
  }
  return { older: turns.slice(0, from), recent: turns.slice(from) };
};

/** The older turns as the quick model reads them: the newest that fit, oldest first. */
export const condenseInput = (older: ReadonlyArray<Exchange>): string => {
  const told: Array<string> = [];
  let used = 0;
  for (const turn of older.toReversed()) {
    const entry = entryOf(turn);
    if (used + entry.length > CONDENSE_INPUT && told.length > 0) break;
    told.unshift(entry);
    used += entry.length;
  }
  return told.join("\n\n");
};

/** The whole system prompt where a harness lets Cerium replace its own. */
export const CONDENSE_INSTRUCTIONS =
  "You condense the start of a conversation between a user and an AI coding agent, for another agent" +
  " that takes the conversation over and sees only your summary and the latest turns. Write at most 350" +
  " words: what the user wants and asked for, the decisions and constraints agreed, what was done (files," +
  " commands, results) and what was left open. Keep names, paths and numbers exact; never invent any." +
  " Plain sentences or a short list, with no preamble.";

/** The older turns as something to condense, not to answer or act on. */
export const condensePrompt = (conversation: string) =>
  [
    "Condense the conversation below. Don't answer it or act on it; reply with the summary alone.",
    "",
    "<conversation>",
    conversation,
    "</conversation>",
  ].join("\n");

const todoMark: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  inProgress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** What a handoff's brief tells beside the conversation. */
export interface BriefContext {
  readonly from: ModelChoice;
  /** Why the lead moved: the user chose to (the default), or the first harness ran out of usage. */
  readonly cause?: "user" | "limit" | undefined;
  /** The older turns condensed (`Condenser`); without it, the brief lists their requests. */
  readonly summary?: string | undefined;
  /** The agents the lead spawned that still run, and report to it. */
  readonly running: ReadonlyArray<Pick<AgentInfo, "id" | "role" | "model">>;
}

/** The most tool calls of an interrupted turn the brief lists, newest kept. */
const MAX_CALLS = 40;

/** What a tool call acted on, in a few words: its command, file, pattern or query. */
const callTarget = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const fields = input as Record<string, unknown>;
  const target = [
    fields["command"],
    fields["file_path"],
    fields["path"],
    fields["pattern"],
    fields["query"],
    fields["url"],
    fields["description"],
  ].find((value): value is string => typeof value === "string" && value.trim() !== "");
  return target === undefined ? "" : clip(target.replace(/\s+/g, " ").trim(), 120);
};

/**
 * What the turn that a limit cut off had done: its tool calls, newest last, and how many came
 * before the ones listed. None when the lead's latest turn wasn't cut off by a limit.
 */
export const interruptedWork = (
  live: ReadonlyArray<AgentEvent>,
): { readonly calls: ReadonlyArray<string>; readonly earlier: number } | undefined => {
  const turn = live.findLastIndex(({ payload }) => payload._tag === "TurnInput");
  if (turn === -1 || !live.slice(turn).some(({ payload }) => payload._tag === "LimitReached")) {
    return undefined;
  }
  const calls = live.slice(turn).flatMap(({ payload }) => {
    if (payload._tag !== "ToolCallStarted") return [];
    const target = callTarget(payload.input);
    return [target === "" ? payload.toolName : `${payload.toolName}: ${target}`];
  });
  return { calls: calls.slice(-MAX_CALLS), earlier: Math.max(0, calls.length - MAX_CALLS) };
};

/**
 * The brief a lead's new session on another harness hears with its first turn: where the
 * conversation came from, what it can't see, the conversation itself (older turns as `summary`, or
 * as the user's requests without one), the files the thread changed, its plan and its running agents.
 */
export const handoffBrief = (live: ReadonlyArray<AgentEvent>, context: BriefContext): string => {
  const { older, recent } = splitConversation(exchanges(live));
  const files = new Map<string, string>();
  let todos: ReadonlyArray<TodoItem> = [];
  for (const { payload } of live) {
    if (payload._tag === "TurnFilesChanged") {
      for (const file of payload.files) {
        files.delete(file.path);
        files.set(file.path, file.change);
      }
    }
    if (payload._tag === "FileChanged" && !files.has(payload.path)) files.set(payload.path, "modified");
    if (payload._tag === "TodosUpdated") todos = payload.items;
  }
  const requests: Array<string> = [];
  let used = 0;
  for (const asked of older.flatMap((turn) => turn.asked).toReversed()) {
    const line = `- ${clip(asked.replace(/\s+/g, " ").trim(), 300)}`;
    if (used + line.length > REQUESTS_BUDGET) break;
    requests.unshift(line);
    used += line.length;
  }
  const named = [...files].slice(-MAX_FILES);
  const interrupted = interruptedWork(live);
  const moved =
    context.cause === "limit"
      ? `${harnessName[context.from.provider]} (${context.from.model}) ran out of usage in the middle of a turn, so Cerium moved this thread to you`
      : `The user moved this thread from ${harnessName[context.from.provider]} (${context.from.model}) to you`;
  const sections = [
    `${HANDOFF_PREFACE} ${moved}, to carry on where it left off. Only the text below came across:` +
      " that session's memory, tool results and open requests stayed behind, so read files again before" +
      " relying on them, and don't redo work already done. Whatever the user sends next follows this notice.",
    ...(older.length === 0
      ? []
      : context.summary !== undefined && context.summary.trim() !== ""
        ? [`## Earlier in the conversation (condensed from ${older.length} turns)`, context.summary.trim()]
        : [
            `## Earlier in the conversation (${older.length} turns, not shown)`,
            ...(requests.length === 0 ? [] : [`The user's messages then:\n${requests.join("\n")}`]),
          ]),
    ...(recent.length === 0
      ? []
      : [
          older.length === 0 ? "## The conversation" : `## The latest ${recent.length} turns`,
          ...recent.map(entryOf),
        ]),
    ...(interrupted === undefined || interrupted.calls.length === 0
      ? []
      : [
          "## What the cut-off turn had done",
          `Its tool calls, in order${interrupted.earlier > 0 ? ` (the last ${interrupted.calls.length}, after ${interrupted.earlier} earlier)` : ""}; their results are not shown, so check the files before relying on them.`,
          interrupted.calls.map((call) => `- ${call}`).join("\n"),
        ]),
    ...(named.length === 0
      ? []
      : [
          `## Files this thread changed${files.size > named.length ? ` (the last ${named.length} of ${files.size})` : ""}`,
          named.map(([path, change]) => `- ${path} (${change})`).join("\n"),
        ]),
    ...(todos.length === 0
      ? []
      : ["## Your plan", todos.map((item) => `- ${todoMark[item.status]} ${item.text}`).join("\n")]),
    ...(context.running.length === 0
      ? []
      : [
          "## Agents still running",
          `${context.running.map((agent) => `- ${agent.id} "${agent.role}" (${agent.model})`).join("\n")}\n` +
            "They report to you now; message them with `send_message` and stop them with `kill_agent`.",
        ]),
  ];
  return sections.join("\n\n");
};

/** The turns of a conversation too old for a handoff to tell word for word, which it condenses. */
export const olderTurns = (live: ReadonlyArray<AgentEvent>): ReadonlyArray<Exchange> =>
  splitConversation(exchanges(live)).older;

/**
 * The handoff whose brief the lead's next turn still owes its new session: the last handoff, when no
 * turn has begun since.
 */
export const pendingHandoff = (live: ReadonlyArray<AgentEvent>): LeadHandedOff | undefined => {
  for (let index = live.length - 1; index >= 0; index--) {
    const { payload } = live[index]!;
    if (payload._tag === "TurnInput" || payload._tag === "ConversationRewound") return undefined;
    if (payload._tag === "LeadHandedOff") return payload;
    if (payload._tag === "WorkspaceMoved") return { ...payload, _tag: "LeadHandedOff" };
  }
  return undefined;
};

/** How long one model may take to condense before the next is tried. */
const ATTEMPT_TIMEOUT = "60 seconds";

export class Condenser extends Context.Service<
  Condenser,
  {
    /**
     * The older turns of a conversation condensed by the quick model that titles threads (`fallback`
     * last, a model known to answer); none when no model answers.
     */
    condense(
      older: ReadonlyArray<Exchange>,
      fallback: ModelChoice,
      agentId?: AgentId,
    ): Effect.Effect<Option.Option<string>>;
  }
>()("cerium/orchestrator/Condenser") {
  static readonly layer = Layer.effect(
    Condenser,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const accounting = yield* HelperUsage;
      const catalog = yield* Catalog;
      const settings = yield* UserSettings;
      const config = yield* OrchestratorConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Titles' empty folder, so no project's instructions load.
      const cwd = config.titleDirectory ?? path.join(config.chatDirectory, ".titles");

      const ask = (choice: ModelChoice, prompt: string, agentId?: AgentId) =>
        Effect.fromNullishOr(adapters.get(choice.provider)).pipe(
          Effect.flatMap((adapter) =>
            adapter.complete({
              model: choice.model,
              instructions: CONDENSE_INSTRUCTIONS,
              prompt,
              cwd,
              ...(agentId === undefined
                ? {}
                : { onUsage: accounting.track({ agentId, purpose: "summary", ...choice }) }),
            }),
          ),
          Effect.timeout(ATTEMPT_TIMEOUT),
          Effect.map((reply) => (reply.trim() === "" ? undefined : reply.trim())),
          Effect.tapCause((cause) =>
            Effect.logWarning(
              `Couldn't condense a conversation with ${choice.provider}/${choice.model}`,
              cause,
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );

      return Condenser.of({
        condense: Effect.fn("Condenser.condense")(function* (older, fallback, agentId) {
          if (older.length === 0) return Option.none();
          const { titles } = yield* settings.get;
          yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore);
          const models = yield* offeredModels(catalog);
          const offered = (choice: ModelChoice) =>
            models.some((model) => model.provider === choice.provider && model.model === choice.model);
          const prompt = condensePrompt(condenseInput(older));
          for (const choice of titleModels(titles, offered, fallback)) {
            const summary = yield* ask(choice, prompt, agentId);
            if (summary !== undefined) return Option.some(summary);
          }
          return Option.none();
        }),
      });
    }),
  ).pipe(Layer.provideMerge(HelperUsage.layer));
}
