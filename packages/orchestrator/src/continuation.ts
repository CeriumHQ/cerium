import type { AgentEvent, TodoItem } from "@cerium/protocol";

import { liveEvents } from "./rewind.ts";

// Continuing a thread in a new one: the new thread's first message is a brief Cerium writes from what
// it already holds (the thread's events and its folder's git), so it costs no model call, and the new
// session starts small instead of reading the old one's whole context again.

/** How the brief starts, which tells a thread continued from a continued one. */
export const CONTINUATION_PREFACE = "This thread continues";

/** The most the brief quotes of each message, in characters. */
const REQUEST_MAX = 6_000;
const MESSAGE_MAX = 4_000;
const REPLY_MAX = 8_000;
/** The most lines it quotes of git's output. */
const COMMITS_MAX = 40;
const STATUS_MAX = 60;

const ORIGINAL_HEADING = "## Original request";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} […]`);

const clipLines = (text: string, max: number) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length <= max
    ? lines.join("\n")
    : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more`;
};

/** The original request a brief quotes, so a thread continued twice still starts from the first. */
const originalOf = (text: string): string => {
  if (!text.startsWith(CONTINUATION_PREFACE)) return text;
  const from = text.indexOf(`${ORIGINAL_HEADING}\n`);
  if (from === -1) return text;
  const rest = text.slice(from + ORIGINAL_HEADING.length + 1);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
};

/** The pull request open for the thread's branch, as the brief names it. */
export interface ContinuationPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly draft: boolean;
}

/** What the brief tells beside the conversation; the parts git or GitHub didn't give are absent. */
export interface ContinuationContext {
  readonly title: string;
  readonly branch?: string | undefined;
  /** The branch the thread's work merges into, which `commits` are counted from. */
  readonly base?: string | undefined;
  /** `git log --oneline <base>..HEAD`. */
  readonly commits?: string | undefined;
  /** `git status --short`. */
  readonly status?: string | undefined;
  readonly pullRequest?: ContinuationPullRequest | undefined;
}

const todoMark: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  inProgress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** What a lead's events hold for a brief: its first and last requests, its last reply and its plan. */
export const continuationParts = (events: ReadonlyArray<AgentEvent>) => {
  const asked: Array<string> = [];
  const seen = new Set<string>();
  let reply: string | undefined;
  let todos: ReadonlyArray<TodoItem> = [];
  const live = liveEvents(events);
  const withdrawn = new Set(
    live.flatMap(({ payload }) => (payload._tag === "MessageWithdrawn" ? [payload.messageId] : [])),
  );
  for (const { payload } of live) {
    // A message is queued, then delivered by a turn; each is counted once, by its id.
    const messages =
      payload._tag === "MessageQueued"
        ? [payload.message]
        : payload._tag === "TurnInput"
          ? payload.items.flatMap((item) => (item._tag === "FromUser" ? [item] : []))
          : [];
    for (const message of messages) {
      if (message.id !== undefined && (seen.has(message.id) || withdrawn.has(message.id))) continue;
      if (message.id !== undefined) seen.add(message.id);
      if (message.text.trim() !== "") asked.push(message.text.trim());
    }
    if (payload._tag === "MessageCompleted" && payload.text.trim() !== "") reply = payload.text.trim();
    if (payload._tag === "TodosUpdated") todos = payload.items;
  }
  return { first: asked[0], last: asked.length > 1 ? asked.at(-1) : undefined, reply, todos };
};

/**
 * The first message of a thread that continues another: what it was asked first and last, its last
 * reply, its plan, and where its branch stands. The user reads and edits it before it is sent.
 */
export const continuationBrief = (
  events: ReadonlyArray<AgentEvent>,
  context: ContinuationContext,
): string => {
  const { first, last, reply, todos } = continuationParts(events);
  const pull = context.pullRequest;
  const branch =
    context.branch === undefined
      ? undefined
      : [
          `Branch \`${context.branch}\`${context.base === undefined ? "" : ` (from \`${context.base}\`)`}.`,
          ...(context.commits === undefined || context.commits.trim() === ""
            ? []
            : [`Its commits:\n\`\`\`\n${clipLines(context.commits, COMMITS_MAX)}\n\`\`\``]),
          context.status === undefined || context.status.trim() === ""
            ? "Nothing uncommitted."
            : `Uncommitted:\n\`\`\`\n${clipLines(context.status, STATUS_MAX)}\n\`\`\``,
          ...(pull === undefined
            ? []
            : [
                `Pull request #${pull.number} “${pull.title}” (${pull.draft && pull.state === "open" ? "draft" : pull.state}): ${pull.url}`,
              ]),
        ].join("\n\n");
  const sections = [
    `${CONTINUATION_PREFACE} “${context.title}”, whose conversation grew too long. Pick up where it left` +
      " off: the files and git hold the work, so read them again rather than trust this summary, and" +
      " don't redo what is done.",
    ...(first === undefined ? [] : [ORIGINAL_HEADING, clip(originalOf(first), REQUEST_MAX)]),
    ...(last === undefined ? [] : ["## Last message from the user", clip(last, MESSAGE_MAX)]),
    ...(reply === undefined ? [] : ["## Last reply", clip(reply, REPLY_MAX)]),
    ...(todos.length === 0
      ? []
      : ["## Plan", todos.map((item) => `- ${todoMark[item.status]} ${item.text}`).join("\n")]),
    ...(branch === undefined ? [] : ["## Where the work stands", branch]),
  ];
  return sections.join("\n\n");
};
