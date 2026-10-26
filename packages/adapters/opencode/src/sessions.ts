import type { AdapterEvent, PastHistory, PastSession, PastTurn } from "@cerium/harness";
import { Effect } from "effect";

import { call, type OpenCodeClient } from "./host.ts";
import { failureOutput, toolOutput } from "./translate.ts";

type SessionInfo = Awaited<ReturnType<OpenCodeClient["session"]["list"]>>["data"][number];
type SessionMessage = Awaited<ReturnType<OpenCodeClient["message"]["list"]>>["data"][number];
type AssistantContent = Extract<SessionMessage, { readonly type: "assistant" }>["content"][number];

/** What Cerium's adapter writes in the metadata of each session it creates. */
export const CERIUM_METADATA = { createdBy: "cerium" } as const;

/** The most sessions a listing reads, newest first. */
const MAX_SESSIONS = 500;
const PAGE = 100;

/** A listed session as a past session, or nothing for a subagent's, an archived one or Cerium's own. */
export const toPastSession = (session: SessionInfo): PastSession | undefined => {
  if (session.parentID !== undefined || session.time.archived !== undefined) return undefined;
  if (session.metadata?.["createdBy"] === CERIUM_METADATA.createdBy) return undefined;
  return {
    id: session.id,
    cwd: session.location.directory,
    title: session.title?.trim() || "OpenCode session",
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    ...(session.model === undefined ? {} : { model: `${session.model.providerID}/${session.model.id}` }),
  };
};

/** The user's OpenCode sessions in every folder, from the server's own listing. */
export const listOpenCodeSessions = (client: OpenCodeClient) =>
  Effect.gen(function* () {
    const sessions: Array<PastSession> = [];
    let cursor: string | undefined;
    let read = 0;
    do {
      const page = yield* call("list its sessions", (signal) =>
        client.session.list({ limit: PAGE, ...(cursor ? { cursor } : { order: "desc" }) }, { signal }),
      );
      read += page.data.length;
      for (const session of page.data) {
        const past = toPastSession(session);
        if (past !== undefined) sessions.push(past);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor !== undefined && read < MAX_SESSIONS);
    return sessions;
  });

const numberOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** One part of an assistant message as canonical events, as the live translator words them. */
const contentEvents = (
  messageId: string,
  index: number,
  part: AssistantContent,
): ReadonlyArray<AdapterEvent> => {
  switch (part.type) {
    case "text":
      return part.text.trim() === ""
        ? []
        : [{ payload: { _tag: "MessageCompleted", messageId: `${messageId}:${index}`, text: part.text } }];
    case "reasoning":
      return part.text.trim() === ""
        ? []
        : [
            {
              payload: {
                _tag: "ReasoningCompleted",
                messageId: `${messageId}:reasoning:${index}`,
                text: part.text,
              },
            },
          ];
    case "tool": {
      const { state } = part;
      const input = state.status === "streaming" ? {} : state.input;
      const started: AdapterEvent = {
        payload: { _tag: "ToolCallStarted", callId: part.id, toolName: part.name, input },
        raw: part,
      };
      switch (state.status) {
        case "completed": {
          const exitCode = numberOf(state.metadata?.["exit"]);
          return [
            started,
            {
              payload: {
                _tag: "ToolCallCompleted",
                callId: part.id,
                output: toolOutput(state.content, exitCode),
                isError: exitCode !== undefined && exitCode !== 0,
              },
            },
          ];
        }
        case "error":
          return [
            started,
            {
              payload: {
                _tag: "ToolCallCompleted",
                callId: part.id,
                output: failureOutput(state.error.message, state.content),
                isError: true,
              },
            },
          ];
        default:
          return [
            started,
            {
              payload: {
                _tag: "ToolCallCompleted",
                callId: part.id,
                output: "The turn ended before this tool call finished.",
                isError: true,
              },
            },
          ];
      }
    }
  }
};

/** A session's messages as turns: each user message, with the assistant messages after it. */
export const toPastHistory = (messages: ReadonlyArray<SessionMessage>): PastHistory => {
  const turns: Array<{ prompt: string; at: number; events: Array<AdapterEvent> }> = [];
  let model: string | undefined;
  for (const message of messages) {
    if (message.type === "user") {
      turns.push({ prompt: message.text, at: message.time.created, events: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined || message.type !== "assistant") continue;
    model = `${message.model.providerID}/${message.model.id}`;
    turn.events.push(...message.content.flatMap((part, index) => contentEvents(message.id, index, part)));
  }
  return { ...(model === undefined ? {} : { model }), turns: turns satisfies ReadonlyArray<PastTurn> };
};

/** An OpenCode session's conversation, read with the server's message listing. */
export const readOpenCodeSession = (client: OpenCodeClient, session: PastSession) =>
  Effect.gen(function* () {
    const messages: Array<SessionMessage> = [];
    let cursor: string | undefined;
    do {
      const page = yield* call("read the session's messages", (signal) =>
        client.message.list(
          { sessionID: session.id, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) },
          { signal },
        ),
      );
      messages.push(...page.data);
      cursor = page.cursor.next ?? undefined;
    } while (cursor !== undefined);
    return toPastHistory(messages);
  });
