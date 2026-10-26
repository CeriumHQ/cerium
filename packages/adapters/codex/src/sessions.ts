import { HarnessFailure, type PastHistory, type PastSession, type PastTurn } from "@cerium/harness";
import { Effect } from "effect";
import { tmpdir } from "node:os";

import type { Thread } from "./protocol/v2/Thread.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import { connect } from "./rpc.ts";
import { CodexTranslator } from "./translate.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/** The most threads a listing reads, newest first. */
const MAX_THREADS = 500;
const PAGE = 100;

/** The name Cerium's adapter gives app-server in its handshake, which Codex records as a thread's originator. */
const CERIUM_ORIGINATOR = "cerium";

/** A listed thread as a past session, or nothing for one that isn't the user's own conversation. */
export const toPastSession = (thread: Thread): PastSession | undefined => {
  if (thread.ephemeral || thread.parentThreadId !== null || thread.originator === CERIUM_ORIGINATOR) {
    return undefined;
  }
  const title = (thread.name ?? thread.preview).trim();
  return {
    id: thread.id,
    ...(thread.cwd === "" ? {} : { cwd: thread.cwd }),
    title: title === "" ? "Codex thread" : title,
    createdAt: thread.createdAt * 1000,
    updatedAt: (thread.recencyAt ?? thread.updatedAt) * 1000,
    ...(thread.model === null ? {} : { model: thread.model }),
  };
};

/**
 * The user's Codex threads, from app-server's `thread/list`: every interactive source and other
 * app-server clients (Codex's own app), less the threads Cerium started and subagents' threads.
 */
export const listCodexSessions = Effect.fn("CodexAdapter.listSessions")(function* (executablePath: string) {
  const server = yield* connect(executablePath, tmpdir());
  const sessions: Array<PastSession> = [];
  let cursor: string | null = null;
  let read = 0;
  do {
    const page: ThreadListResponse = yield* server
      .request("thread/list", {
        cursor,
        limit: PAGE,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
      })
      .pipe(Effect.mapError(failure("Could not list the Codex threads")));
    read += page.data.length;
    for (const thread of page.data) {
      const session = toPastSession(thread);
      if (session !== undefined) sessions.push(session);
    }
    cursor = page.nextCursor;
  } while (cursor !== null && read < MAX_THREADS);
  return sessions;
}, Effect.scoped);

/** What the user sent in a turn: its text, with images and skills named. */
const promptOf = (item: Extract<ThreadItem, { type: "userMessage" }>): string =>
  item.content
    .map((input) => {
      switch (input.type) {
        case "text":
          return input.text;
        case "skill":
        case "mention":
          return `$${input.name}`;
        case "image":
        case "localImage":
          return "(image)";
        default:
          return "";
      }
    })
    .filter((part) => part !== "")
    .join("\n\n");

const STOP_REASONS: Readonly<Record<string, "completed" | "interrupted" | "error">> = {
  completed: "completed",
  interrupted: "interrupted",
  failed: "error",
};

/**
 * A thread's turns as past turns: each turn's user message is its prompt, and its other items go
 * through the translator a live session uses, as if each had just completed.
 */
export const toPastHistory = (threadId: string, turns: ReadonlyArray<Turn>): PastHistory => {
  const translator = new CodexTranslator();
  const past: Array<PastTurn> = [];
  for (const turn of turns) {
    if (turn.rootTurnId !== null && turn.rootTurnId !== turn.id) continue;
    const prompt = turn.items.flatMap((item) => (item.type === "userMessage" ? [promptOf(item)] : []));
    const events = turn.items.flatMap((item) =>
      item.type === "userMessage"
        ? []
        : translator.translate({
            method: "item/completed",
            params: { item, threadId, turnId: turn.id, completedAtMs: (turn.completedAt ?? 0) * 1000 },
          }),
    );
    const stopReason = STOP_REASONS[turn.status];
    past.push({
      prompt: prompt.join("\n\n"),
      ...(turn.startedAt === null ? {} : { at: turn.startedAt * 1000 }),
      events:
        stopReason === undefined ? events : [...events, { payload: { _tag: "TurnCompleted", stopReason } }],
    });
  }
  return { turns: past };
};

/** A Codex thread's conversation, read with `thread/turns/list` on an app-server of its own. */
export const readCodexSession = Effect.fn("CodexAdapter.readSession")(function* (
  executablePath: string,
  session: PastSession,
) {
  const server = yield* connect(executablePath, session.cwd ?? tmpdir());
  const turns: Array<Turn> = [];
  let cursor: string | null = null;
  do {
    const page: ThreadTurnsListResponse = yield* server
      .request("thread/turns/list", { threadId: session.id, cursor, sortDirection: "asc", itemsView: "full" })
      .pipe(Effect.mapError(failure("Could not read the Codex thread")));
    turns.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { ...toPastHistory(session.id, turns), ...(session.model ? { model: session.model } : {}) };
}, Effect.scoped);
