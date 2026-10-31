import {
  HarnessFailure,
  type AdapterEvent,
  type PastHistory,
  type PastSession,
  type PastTurn,
} from "@cerium/harness";
import { Effect } from "effect";

import { AcpError, type AcpConnection } from "./connection.ts";
import type { AcpHarness } from "./harness.ts";
import type { ListSessionsResponse, SessionNotification, SessionSetup, SessionUpdate } from "./schema.ts";
import { AcpTranslator, textOf } from "./translate.ts";

// The user's past sessions with an ACP agent: `session/list` lists them, and `session/load` replays one
// as the updates it streamed live, which the live translator words the same way.

/** The most sessions a listing reads. */
const MAX_SESSIONS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What history keeps of a replay's events: what was said and done, not turn bookkeeping. */
const HISTORY_TAGS = new Set<string>([
  "MessageCompleted",
  "ReasoningCompleted",
  "ToolCallStarted",
  "ToolCallCompleted",
  "FileChanged",
  "TodosUpdated",
  "ContextCompacted",
]);

/** Every session the agent lists, newest first. */
export const listAcpSessions = (harness: AcpHarness, connection: AcpConnection) =>
  Effect.gen(function* () {
    const sessions: Array<PastSession> = [];
    let cursor: string | undefined;
    do {
      const page: ListSessionsResponse = yield* connection
        .request<ListSessionsResponse>("session/list", cursor === undefined ? {} : { cursor })
        .pipe(
          Effect.mapError(
            (cause) =>
              new HarnessFailure({
                provider: harness.provider,
                message: `${harness.name} couldn't list its sessions: ${cause.message}`,
                cause,
              }),
          ),
        );
      for (const info of Array.isArray(page.sessions) ? page.sessions : []) {
        if (typeof info.sessionId !== "string" || info.sessionId === "") continue;
        const updated = typeof info.updatedAt === "string" ? Date.parse(info.updatedAt) : Number.NaN;
        sessions.push({
          id: info.sessionId,
          ...(typeof info.cwd === "string" && info.cwd !== "" ? { cwd: info.cwd } : {}),
          title: info.title?.trim() || `${harness.name} session`,
          updatedAt: Number.isFinite(updated) ? updated : 0,
        });
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
    } while (cursor !== undefined && sessions.length < MAX_SESSIONS);
    return sessions.toSorted((left, right) => right.updatedAt - left.updatedAt);
  });

/**
 * A replay's updates as turns: each run of user chunks opens a turn whose prompt is their text, and
 * what the agent did until the next one is the turn's events.
 */
export const historyFromUpdates = (
  harness: Pick<AcpHarness, "provider" | "describeTool">,
  updates: ReadonlyArray<SessionUpdate>,
  servers: ReadonlyArray<string> = [],
): PastHistory => {
  const translator = new AcpTranslator({
    provider: harness.provider,
    mcpServers: servers,
    ...(harness.describeTool ? { describeTool: (call, known) => harness.describeTool!(call, known) } : {}),
  });
  const turns: Array<{ prompt: string; events: Array<AdapterEvent> }> = [];
  let userOpen = false;
  const keep = (events: ReadonlyArray<AdapterEvent>) => {
    const turn = turns.at(-1);
    if (turn === undefined) return;
    turn.events.push(...events.filter((event) => HISTORY_TAGS.has(event.payload._tag)));
  };
  for (const update of updates) {
    if (!isRecord(update)) continue;
    if (update.sessionUpdate === "user_message_chunk") {
      if (!userOpen) {
        // The previous turn ends where the next prompt starts.
        if (turns.length > 0)
          keep(translator.translate({ type: "prompted", response: { stopReason: "end_turn" } }));
        keep(translator.translate({ type: "prompt" }));
        turns.push({ prompt: "", events: [] });
        userOpen = true;
      }
      turns.at(-1)!.prompt += textOf(update.content);
      continue;
    }
    userOpen = false;
    keep(translator.translate({ type: "update", update }));
  }
  if (turns.length > 0)
    keep(translator.translate({ type: "prompted", response: { stopReason: "end_turn" } }));
  return { turns: turns.map((turn): PastTurn => ({ prompt: turn.prompt.trim(), events: turn.events })) };
};

/** A session's conversation, from `session/load`'s replay. */
export const readAcpSession = (
  harness: AcpHarness,
  connection: AcpConnection,
  session: PastSession,
  cwd: string,
) =>
  Effect.gen(function* () {
    const updates: Array<SessionUpdate> = [];
    connection.onNotification((method, params) => {
      if (method !== "session/update" || !isRecord(params)) return;
      const notification = params as unknown as SessionNotification;
      if (notification.sessionId === session.id && isRecord(notification.update))
        updates.push(notification.update);
    });
    yield* connection
      .request<SessionSetup>("session/load", {
        sessionId: session.id,
        cwd: session.cwd ?? cwd,
        mcpServers: [],
      })
      .pipe(
        Effect.mapError(
          (cause: AcpError) =>
            new HarnessFailure({
              provider: harness.provider,
              message: `${harness.name} couldn't load the session: ${cause.message}`,
              cause,
            }),
        ),
      );
    if (connection.initialized.agentCapabilities?.sessionCapabilities?.close) {
      yield* connection.request("session/close", { sessionId: session.id }).pipe(Effect.ignore);
    }
    return historyFromUpdates(harness, updates);
  });
