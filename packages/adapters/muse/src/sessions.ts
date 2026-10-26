import { HarnessFailure, type AdapterEvent, type PastHistory, type PastSession } from "@cerium/harness";
import type { Item, Session, SessionListResult, SessionReadResult } from "@muse-code/sdk/dist/src/msp.js";
import { Effect } from "effect";
import { normalize } from "node:path";

import { openHost, query, type MuseHost } from "./host.ts";
import { MuseTranslator } from "./translate.ts";

/** The most sessions a listing reads, newest first. */
const MAX_SESSIONS = 600;
const PAGE = 200;

/** The `clientInfo.name` Cerium's adapter opens `muse serve` with, which Muse records on a session. */
const CERIUM_CLIENT = "cerium";

const time = (rfc3339: string | undefined): number | undefined => {
  if (rfc3339 === undefined) return undefined;
  const ms = Date.parse(rfc3339);
  return Number.isNaN(ms) ? undefined : ms;
};

/** A workspace root as a plain path: Muse may record Windows' `\\?\` long-path form or forward slashes. */
export const plainPath = (root: string): string => normalize(root.replace(/^\\\\\?\\/, ""));

/** A listed session as a past session, or nothing for a subagent's, an ephemeral one or Cerium's own. */
export const toPastSession = (session: Session): PastSession | undefined => {
  if (session.kind === "subagent" || session.path === "" || session.createdByClient?.name === CERIUM_CLIENT) {
    return undefined;
  }
  const title = (session.name ?? session.title ?? session.firstUserPrompt ?? "").trim();
  const createdAt = time(session.createdAt);
  return {
    id: session.sessionId,
    ...(session.workspaceRoot === null ? {} : { cwd: plainPath(session.workspaceRoot) }),
    title: title === "" ? "Muse Code session" : title,
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt: time(session.lastActivityAt) ?? time(session.updatedAt) ?? createdAt ?? 0,
    turns: session.turnCount,
    ...(session.modelId === null ? {} : { model: session.modelId }),
  };
};

/** Reading stored sessions needs the session log: a host started without it serves no `session/read`. */
const withHost = <A, E>(executablePath: string, use: (host: MuseHost) => Effect.Effect<A, E>) =>
  Effect.scoped(
    openHost(executablePath, ["serve"], { capabilities: { userInputDialogs: false } }).pipe(
      Effect.flatMap(use),
    ),
  );

/** The user's Muse Code sessions, from `session/list`. */
export const listMuseSessions = Effect.fn("MuseAdapter.listSessions")(function* (executablePath: string) {
  return yield* withHost(executablePath, (host) =>
    Effect.gen(function* () {
      const sessions: Array<PastSession> = [];
      let cursor: string | null = null;
      let read = 0;
      do {
        const page = (yield* query(host, "session/list", {
          cursor,
          limit: PAGE,
        })) as unknown as SessionListResult;
        read += page.sessions.length;
        for (const session of page.sessions) {
          const past = toPastSession(session);
          if (past !== undefined) sessions.push(past);
        }
        cursor = page.nextCursor;
      } while (cursor !== null && read < MAX_SESSIONS);
      return sessions;
    }),
  );
});

/**
 * A session's folded items as turns: each user message starts one, and the items after it go through
 * the translator a live session uses, as if each had just completed.
 */
export const toPastHistory = (items: ReadonlyArray<Item>, workspace: string): PastHistory => {
  const translator = new MuseTranslator({ workspace, resumed: true });
  const turns: Array<{ prompt: string; at?: number; events: Array<AdapterEvent> }> = [];
  for (const item of items) {
    if (item.retracted === true) continue;
    if (item.kind === "userMessage") {
      const at = time(item.recordedAt);
      turns.push({
        prompt: item.displayText ?? item.text ?? "",
        ...(at === undefined ? {} : { at }),
        events: [],
      });
      continue;
    }
    turns.at(-1)?.events.push(...translator.translate({ method: "item/completed", params: { item } }));
  }
  return { turns };
};

/** A Muse Code session's conversation, from `session/read` with its items. */
export const readMuseSession = Effect.fn("MuseAdapter.readSession")(function* (
  executablePath: string,
  session: PastSession,
) {
  const answer = (yield* withHost(executablePath, (host) =>
    query(host, "session/read", { sessionId: session.id, excludeItems: false }),
  )) as unknown as SessionReadResult;
  const items = answer.history.items ?? answer.history.snapshot?.state.items;
  if (items === undefined) {
    return yield* new HarnessFailure({
      provider: "muse",
      message: `Muse Code served no history for this session (${answer.history.noneReason ?? answer.history.mode}).`,
      cause: answer.history,
    });
  }
  return {
    ...toPastHistory(items, session.cwd ?? answer.session.workspaceRoot ?? ""),
    ...(answer.session.modelId === null ? {} : { model: answer.session.modelId }),
  };
});
