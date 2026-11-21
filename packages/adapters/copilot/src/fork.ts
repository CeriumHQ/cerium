import { HarnessFailure, type ForkRequest } from "@cerium/harness";
import { Effect } from "effect";

import { record, string, type CopilotHost } from "./rpc.ts";
import { isUserTurn, readPersistedEvents } from "./sessions.ts";

/**
 * Where a fork of `events` ends: `sessions.fork` copies the events before `toEventId`. A turn is named
 * by the `clientTurnId` Cerium sent it with, or else by its place among the user's messages. Absent
 * means the whole session.
 */
export const forkBoundary = (
  events: ReadonlyArray<Record<string, unknown>>,
  request: Pick<ForkRequest, "before" | "through">,
): { readonly toEventId?: string } | undefined => {
  const turns = events.filter(isUserTurn);
  const ref = request.before ?? request.through;
  if (ref === undefined) return undefined;
  const byId =
    ref.id === undefined
      ? -1
      : turns.findIndex((event) => record(event["data"])?.["clientTurnId"] === ref.id);
  const index = byId >= 0 ? byId : ref.index;
  if (index < 0 || index >= turns.length) return undefined;
  const cut = request.before !== undefined ? turns[index] : turns[index + 1];
  if (cut === undefined) return {};
  const id = string(cut["id"]);
  return id === undefined ? undefined : { toEventId: id };
};

/** Copies a Copilot session up to a turn into a new local session, which resumes like any other. */
export const forkCopilotSession = Effect.fn("CopilotAdapter.fork")(function* (
  host: CopilotHost,
  request: ForkRequest,
) {
  const boundary = forkBoundary(yield* readPersistedEvents(host, request.sessionId), request);
  if (boundary === undefined) {
    return yield* new HarnessFailure({
      provider: "copilot",
      message: "GitHub Copilot's session has no such turn to fork at",
      cause: request,
    });
  }
  const forked = record(
    yield* host.request("sessions.fork", { sessionId: request.sessionId, ...boundary }, "2 minutes"),
  );
  const sessionId = string(forked?.["sessionId"]);
  if (sessionId === undefined) {
    return yield* new HarnessFailure({
      provider: "copilot",
      message: "GitHub Copilot CLI did not fork the session",
      cause: forked,
    });
  }
  return sessionId;
});
