import { HarnessFailure, type ForkRequest } from "@cerium/harness";
import { Effect } from "effect";

import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import { connect, type AppServer } from "./rpc.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/** The thread's turns from its first, without the turns Codex starts itself on behalf of another. */
const listTurns = (server: AppServer, threadId: string) =>
  Effect.gen(function* () {
    const turns: Array<Turn> = [];
    let cursor: string | null = null;
    do {
      const page: ThreadTurnsListResponse = yield* server.request("thread/turns/list", {
        threadId,
        cursor,
        sortDirection: "asc",
        itemsView: "notLoaded",
      });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return turns.filter((turn) => turn.rootTurnId === null || turn.rootTurnId === turn.id);
  });

/**
 * Copies a Codex thread through the turn before `before` with `thread/fork`, on an app-server of its
 * own. Codex makes its own turn ids, so the turn is found by its place.
 */
export const forkCodexThread = Effect.fn("CodexAdapter.fork")(function* (
  executablePath: string,
  request: ForkRequest,
) {
  const server = yield* connect(executablePath, request.cwd);
  const turns = yield* listTurns(server, request.sessionId).pipe(
    Effect.mapError(failure("Could not read the Codex thread's turns")),
  );
  const lastTurnId = turns[request.before.index - 1]?.id;
  if (lastTurnId === undefined || request.before.index > turns.length) {
    return yield* new HarnessFailure({
      provider: "codex",
      message: "Could not find that message in the Codex thread.",
      cause: { turns: turns.length, before: request.before.index },
    });
  }
  const { thread } = yield* server
    .request("thread/fork", { threadId: request.sessionId, lastTurnId, cwd: request.cwd, excludeTurns: true })
    .pipe(Effect.mapError(failure("Could not fork the Codex thread")));
  return thread.id;
}, Effect.scoped);
