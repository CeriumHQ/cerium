import type { AdapterEvent, PastHistory, PastSession, PastTurn } from "@cerium/harness";
import { Effect } from "effect";

import { failure, record, string, type CopilotHost } from "./rpc.ts";
import { CLIENT_NAME } from "./session.ts";
import { translateEvent } from "./translate.ts";

// The user's own Copilot CLI sessions, as the CLI lists and journals them: `sessions.list` reads each
// session's metadata and `sessions.readPersistedEvents` its event log, without opening or resuming it.

const time = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/** A listed local session as a past session, or nothing for a detached one or one Cerium started. */
export const toPastSession = (value: unknown): PastSession | undefined => {
  const session = record(value);
  const id = string(session?.["sessionId"]);
  if (!session || !id || session["isRemote"] !== false || session["isDetached"] === true) return undefined;
  if (session["clientName"] === CLIENT_NAME) return undefined;
  const cwd = string(record(session["context"])?.["cwd"]);
  const title = (string(session["name"]) ?? string(session["summary"]) ?? "").trim();
  const createdAt = time(session["startTime"]);
  return {
    id,
    ...(cwd ? { cwd } : {}),
    title: title === "" ? "GitHub Copilot session" : title,
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt: time(session["modifiedTime"]) ?? createdAt ?? 0,
  };
};

/** The user's local sessions, newest first. */
export const listCopilotSessions = Effect.fn("CopilotAdapter.listSessions")(function* (host: CopilotHost) {
  const listed = record(yield* host.request("sessions.list", { source: "local" }, "2 minutes"));
  const sessions = listed?.["sessions"];
  if (!Array.isArray(sessions)) {
    return yield* failure("GitHub Copilot CLI returned an invalid session list")(listed);
  }
  return sessions
    .flatMap((session) => {
      const past = toPastSession(session);
      return past === undefined ? [] : [past];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/** Every persisted event of a session, oldest first. */
export const readPersistedEvents = Effect.fn("CopilotAdapter.readPersistedEvents")(function* (
  host: CopilotHost,
  sessionId: string,
) {
  const events: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = record(
      yield* host.request(
        "sessions.readPersistedEvents",
        { sessionId, max: 1000, ...(cursor === undefined ? {} : { cursor }) },
        "2 minutes",
      ),
    );
    if (!page || !Array.isArray(page["events"]) || page["cursorStatus"] === "expired") {
      return yield* failure("GitHub Copilot CLI could not read the session's history")(page);
    }
    for (const event of page["events"]) {
      const each = record(event);
      if (each) events.push(each);
    }
    cursor = string(page["cursor"]);
    if (page["hasMore"] !== true || cursor === undefined) return events;
  }
});

/**
 * Whether an event is a message the user sent the main agent, which starts a turn. Copilot marks the
 * prompts it adds itself (a skill's hidden text, another agent's message) with a `source`.
 */
export const isUserTurn = (event: Record<string, unknown>) => {
  if (event["type"] !== "user.message" || event["agentId"] !== undefined) return false;
  const source = record(event["data"])?.["source"];
  return source === undefined || source === "user";
};

/** Events the history leaves out: deltas a completed message repeats, and live context readings. */
const LIVE_ONLY = new Set(["assistant.message_delta", "assistant.reasoning_delta", "session.usage_info"]);

/** A session's journal as turns: each message the user sent, with what the agent did after it. */
export const toPastHistory = (events: ReadonlyArray<Record<string, unknown>>): PastHistory => {
  const turns: Array<{ prompt: string; at?: number; events: Array<AdapterEvent> }> = [];
  let model: string | undefined;
  for (const event of events) {
    const data = record(event["data"]) ?? {};
    if (event["type"] === "session.start" || event["type"] === "session.resume") {
      model = string(data["selectedModel"]) ?? model;
      continue;
    }
    if (event["type"] === "session.model_change") {
      model = string(data["newModel"]) ?? model;
      continue;
    }
    if (isUserTurn(event)) {
      const at = time(event["timestamp"]);
      turns.push({ prompt: string(data["content"]) ?? "", ...(at === undefined ? {} : { at }), events: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined || event["agentId"] !== undefined) continue;
    if (event["type"] === "session.idle") {
      turn.events.push({
        payload: {
          _tag: "TurnCompleted",
          stopReason: data["aborted"] === true ? "interrupted" : "completed",
        },
        raw: event,
      });
      continue;
    }
    if (LIVE_ONLY.has(String(event["type"]))) continue;
    for (const payload of translateEvent(event, data)) turn.events.push({ payload, raw: event });
  }
  return { ...(model === undefined ? {} : { model }), turns: turns satisfies ReadonlyArray<PastTurn> };
};

export const readCopilotSession = Effect.fn("CopilotAdapter.readSession")(function* (
  host: CopilotHost,
  session: PastSession,
) {
  return toPastHistory(yield* readPersistedEvents(host, session.id));
});
