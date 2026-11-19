import { HarnessFailure, type ForkRequest } from "@cerium/harness";
import { Effect } from "effect";

import { call, type OpenCodeClient } from "./host.ts";

/** The session's user messages from its first: one per turn Cerium sent. */
const listPrompts = (client: OpenCodeClient, sessionId: string) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let cursor: string | undefined;
    do {
      const page = yield* call("read the session's messages", (signal) =>
        // A cursor carries the order the first page was asked in.
        client.message.list(
          { sessionID: sessionId, type: "user", limit: 200, ...(cursor ? { cursor } : { order: "asc" }) },
          { signal },
        ),
      );
      ids.push(...page.data.map((message) => message.id));
      cursor = page.cursor.next ?? undefined;
    } while (cursor !== undefined);
    return ids;
  });

/** Copies an OpenCode session up to the next excluded user message, with `session.fork`. */
export const forkOpenCodeSession = (client: OpenCodeClient, request: ForkRequest) =>
  Effect.gen(function* () {
    const prompts = yield* listPrompts(client, request.sessionId);
    const index = request.through === undefined ? request.before.index : request.through.index + 1;
    const before = prompts[index];
    if (before === undefined && !(request.through !== undefined && index === prompts.length)) {
      return yield* new HarnessFailure({
        provider: "opencode",
        message: "Could not find that message in the OpenCode session.",
        cause: { prompts: prompts.length, index },
      });
    }
    const forked = yield* call("fork the session", (signal) =>
      client.session.fork(
        { sessionID: request.sessionId, ...(before === undefined ? {} : { before }) },
        { signal },
      ),
    );
    // Forking without a boundary copies the whole session. Reject it if a new prompt arrived
    // between reading the last turn and forking.
    if (before === undefined && (yield* listPrompts(client, forked.id)).length !== index) {
      return yield* new HarnessFailure({
        provider: "opencode",
        message: "The OpenCode session advanced while being forked.",
        cause: undefined,
      });
    }
    return forked.id;
  });
