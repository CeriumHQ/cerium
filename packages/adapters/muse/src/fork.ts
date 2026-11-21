import { HarnessFailure, type ForkRequest } from "@cerium/harness";
import type {
  Item,
  SessionForkResult,
  SessionReadResult,
  SessionStartResult,
} from "@muse-code/sdk/dist/src/msp.js";
import { Effect } from "effect";

import { openHost, query } from "./host.ts";
import { serveArgs } from "./policy.ts";

/** MSP cuts after a native turn ID. null is an empty prefix, undefined is an unknown boundary. */
export const museForkBoundary = (
  items: ReadonlyArray<Item>,
  request: Pick<ForkRequest, "before" | "through">,
): string | null | undefined => {
  const ref = request.before ?? request.through;
  if (ref === undefined) return undefined;
  const turns = [
    ...new Set(
      items.flatMap((item) =>
        item.kind === "userMessage" && !item.retracted && item.turnId ? [item.turnId] : [],
      ),
    ),
  ];
  const byId = ref.id === undefined ? -1 : turns.indexOf(ref.id);
  const index = byId < 0 ? ref.index : byId;
  if (index < 0 || index >= turns.length) return undefined;
  if (request.before !== undefined && index === 0) return null;
  return turns[request.before === undefined ? index : index - 1];
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });

export const forkMuseSession = Effect.fn("MuseAdapter.fork")(function* (
  executable: string,
  request: ForkRequest,
) {
  const host = yield* openHost(executable, serveArgs({ access: "readOnly" }), {
    cwd: request.cwd,
    capabilities: { userInputDialogs: false },
  });
  const source = (yield* query(host, "session/read", {
    sessionId: request.sessionId,
    excludeItems: false,
  })) as unknown as SessionReadResult;
  const items = source.history.items ?? source.history.snapshot?.state.items;
  const lastTurnId = items === undefined ? undefined : museForkBoundary(items, request);
  if (lastTurnId === undefined) return yield* failure("Muse Code has no such turn to fork at")(undefined);
  // MSP has no empty cut point. Rewinding before the first prompt opens a fresh native session.
  const result = yield* Effect.tryPromise({
    try: () =>
      lastTurnId === null
        ? host.connection.command("session/start", {
            workspaceRoot: request.cwd,
            ...(source.session.modelId === null ? {} : { modelId: source.session.modelId }),
          })
        : host.connection.command("session/fork", {
            sessionId: request.sessionId,
            cutPoint: { lastTurnId },
            excludeItems: true,
          }),
    catch: failure("Muse Code could not fork the session"),
  });
  return (result as unknown as SessionForkResult | SessionStartResult).session.sessionId;
}, Effect.scoped);
