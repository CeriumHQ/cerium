import { openSession, record, string, type AcpConnection } from "@cerium/acp";
import type { ForkRequest, SideQuestionRequest } from "@cerium/harness";
import { Effect } from "effect";
import { resolve } from "node:path";

import { failure } from "./manifest.ts";

export const replayMeta = { "x.ai/restore_code": false, "x.ai/skip_envrc": true } as const;

/** Grok's inclusive prompt index is zero-based. Forking before index zero needs an empty session. */
export const forkGrokSession = Effect.fn("Grok.fork")(function* (acp: AcpConnection, request: ForkRequest) {
  const cwd = resolve(request.cwd);
  const turn = request.through ?? request.before;
  if (!Number.isSafeInteger(turn.index) || turn.index < 0)
    return yield* failure("Invalid Grok Build fork turn");
  const index = request.through === undefined ? turn.index - 1 : turn.index;
  if (index === -1) {
    const opened = record(yield* openSession(acp, "session/new", { cwd, mcpServers: [], _meta: replayMeta }));
    const sessionId = string(opened?.["sessionId"]);
    if (!sessionId) return yield* failure("Grok Build did not return the empty session's ID");
    yield* acp.call("session/close", { sessionId });
    return sessionId;
  }
  const forked = record(
    yield* acp.call("_x.ai/session/fork", {
      sourceSessionId: request.sessionId,
      sourceCwd: cwd,
      newCwd: cwd,
      targetPromptIndex: index,
    }),
  );
  const sessionId = string(forked?.["newSessionId"]);
  if (!sessionId || sessionId === request.sessionId)
    return yield* failure("Grok Build did not return a new fork ID");
  return sessionId;
});

/** Grok's native side question takes a snapshot of the loaded history and leaves it untouched. */
export const askGrokSideQuestion = Effect.fn("Grok.sideQuestion")(function* (
  acp: AcpConnection,
  request: SideQuestionRequest,
) {
  yield* openSession(acp, "session/load", {
    sessionId: request.sessionId,
    cwd: resolve(request.cwd),
    mcpServers: [],
    _meta: {
      ...replayMeta,
      agentProfile: { name: "cerium", injectDefaultTools: false, toolConfig: { tools: [] } },
    },
  });
  const response = yield* acp
    .call("_x.ai/btw", {
      sessionId: request.sessionId,
      question: [request.instructions, request.prompt].filter(Boolean).join("\n\n"),
    })
    .pipe(
      Effect.ensuring(
        Effect.sync(() =>
          request.onUsage?.({
            inputTokens: 0,
            outputTokens: 0,
            unreported: true,
          }),
        ),
      ),
    );
  const answer = string(record(record(response)?.["result"])?.["answer"]);
  if (!answer?.trim()) return yield* failure("Grok Build returned no side-question answer");
  return answer;
});
