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

/** Copies an OpenCode session up to the user message that started `before`, with `session.fork`. */
export const forkOpenCodeSession = (client: OpenCodeClient, request: ForkRequest) =>
  Effect.gen(function* () {
    const prompts = yield* listPrompts(client, request.sessionId);
    const before = prompts[request.before.index];
    if (before === undefined) {
      return yield* new HarnessFailure({
        provider: "opencode",
        message: "Could not find that message in the OpenCode session.",
        cause: { prompts: prompts.length, before: request.before.index },
      });
    }
    const forked = yield* call("fork the session", (signal) =>
      client.session.fork({ sessionID: request.sessionId, before }, { signal }),
    );
    return forked.id;
  });
