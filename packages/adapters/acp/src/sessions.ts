import { HarnessFailure, type AdapterEvent, type PastHistory, type PastSession } from "@cerium/harness";
import type { ProviderId } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

import { METHOD_NOT_FOUND, AcpRequestError, type AcpConnection } from "./connection.ts";
import { SessionList, SessionNotification, textOf, type SessionInfo } from "./schema.ts";
import { AcpTranslator, type ToolCallState, type ToolView } from "./translate.ts";

// The user's own sessions with an ACP agent: `session/list` lists them, and `session/load` replays
// one's conversation as the updates a live session sends.

const decodeList = Schema.decodeUnknownEffect(SessionList);
const decodeNotification = Schema.decodeUnknownOption(SessionNotification);

/** How many sessions a listing reads at most. */
const LISTED = 1_000;

const timeOf = (value: string | null | undefined): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

export const toPastSession = (session: SessionInfo): PastSession => {
  const updatedAt = timeOf(session.updatedAt) ?? 0;
  return {
    id: session.sessionId,
    cwd: session.cwd,
    title: session.title?.trim() || "Untitled session",
    updatedAt,
  };
};

/** Every session the agent lists, newest first. */
export const listAcpSessions = (connection: AcpConnection, provider: ProviderId) =>
  Effect.gen(function* () {
    const sessions: Array<SessionInfo> = [];
    let cursor: string | undefined;
    do {
      const page = yield* connection.request("session/list", cursor === undefined ? {} : { cursor }).pipe(
        Effect.flatMap(decodeList),
        Effect.mapError(
          (cause) => new HarnessFailure({ provider, message: "Could not list sessions", cause }),
        ),
      );
      sessions.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && sessions.length < LISTED);
    return sessions
      .map(toPastSession)
      .toSorted((a, b) => b.updatedAt - a.updatedAt) as ReadonlyArray<PastSession>;
  });

/** Events only a live turn has: its streaming, and what closes it. */
const LIVE_ONLY = new Set([
  "MessageDelta",
  "ReasoningDelta",
  "TurnCompleted",
  "UsageReported",
  "ContextReported",
]);

interface Gathering {
  prompt: string;
  readonly events: Array<AdapterEvent>;
  /** Its prompt is still arriving. */
  asking: boolean;
}

/**
 * A listed session's conversation, as `session/load` replays it: each run of the user's message
 * chunks opens a turn, and what follows is its reply.
 */
export const readAcpSession = (
  connection: AcpConnection,
  session: PastSession,
  options: {
    readonly provider: ProviderId;
    readonly cwd: string;
    readonly view?: (call: ToolCallState) => ToolView;
    readonly output?: (call: ToolCallState) => unknown;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const translator = new AcpTranslator({
        provider: options.provider,
        ...(options.view === undefined ? {} : { view: options.view }),
        ...(options.output === undefined ? {} : { output: options.output }),
      });
      const turns: Array<Gathering> = [];
      const close = () => {
        const last = turns.at(-1);
        if (last === undefined) return;
        last.events.push(
          ...translator
            .endTurn({ stopReason: "completed" })
            .filter((event) => !LIVE_ONLY.has(event.payload._tag)),
        );
      };
      yield* connection.attach(session.id, {
        notification: (method, params) =>
          Effect.sync(() => {
            if (method !== "session/update") return;
            const update = Option.getOrUndefined(decodeNotification(params))?.update;
            if (update === undefined) return;
            if (update.sessionUpdate === "user_message_chunk") {
              const last = turns.at(-1);
              if (last === undefined || !last.asking) {
                close();
                turns.push({ prompt: "", events: [], asking: true });
              }
              turns.at(-1)!.prompt += textOf([update.content]);
              return;
            }
            const events = translator
              .update(update, params)
              .filter((event) => !LIVE_ONLY.has(event.payload._tag));
            // Whatever the agent says next ends the prompt before it, even a delta kept for later.
            const last = turns.at(-1);
            if (last !== undefined) last.asking = false;
            if (events.length === 0) return;
            if (last === undefined) turns.push({ prompt: "", events: [], asking: false });
            turns.at(-1)!.events.push(...events);
          }),
        request: (method) =>
          Effect.fail(
            new AcpRequestError({ method, code: METHOD_NOT_FOUND, message: "A past session asks nothing" }),
          ),
      });
      yield* connection
        .request("session/load", { sessionId: session.id, cwd: session.cwd ?? options.cwd, mcpServers: [] })
        .pipe(
          Effect.mapError(
            (cause) =>
              new HarnessFailure({
                provider: options.provider,
                message: "Could not read the session",
                cause,
              }),
          ),
        );
      close();
      // The agent keeps a loaded session open; closing it frees it, where the agent can.
      yield* connection.request("session/close", { sessionId: session.id }).pipe(Effect.ignore);
      return {
        turns: turns
          .filter((turn) => turn.prompt.trim() !== "" || turn.events.length > 0)
          .map((turn) => ({ prompt: turn.prompt, events: turn.events })),
      } satisfies PastHistory;
    }),
  );
