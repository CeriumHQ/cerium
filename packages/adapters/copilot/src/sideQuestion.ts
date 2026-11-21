import type { SideQuestionRequest } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Effect } from "effect";
import { resolve } from "node:path";

import { answer } from "./complete.ts";
import { failure, record, string, type CopilotHost } from "./rpc.ts";
import { startCopilotSession } from "./session.ts";

/**
 * Asks a copy of a Copilot session one question. `sessions.fork` copies the session's persisted
 * history, even while the session runs elsewhere; the copy resumes with only the tools that read and
 * asks nothing of the user (a request that would need approval is refused), answers, and is deleted
 * with everything it saved, so it never joins the user's sessions and the session never learns of it.
 */
export const askCopilotSideQuestion = Effect.fn("CopilotAdapter.sideQuestion")(function* (
  host: CopilotHost,
  request: SideQuestionRequest,
  models: ReadonlyArray<ModelInfo>,
) {
  const forked = record(yield* host.request("sessions.fork", { sessionId: request.sessionId }, "2 minutes"));
  const copy = string(forked?.["sessionId"]);
  if (copy === undefined) return yield* failure("GitHub Copilot CLI did not copy the session")(forked);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* startCopilotSession(host, {
        options: {
          cwd: resolve(request.cwd),
          model: request.model,
          access: "readOnly",
          mcpServers: {},
          includeUserMcpServers: false,
          resume: copy,
        },
        models,
        answering: { instructions: request.instructions, conversation: true },
      });
      return yield* answer(session, request.prompt, request.onUsage, "its answer");
    }),
  ).pipe(
    // Delete the copy even when opening it was interrupted or refused.
    Effect.ensuring(
      host.request("sessions.delete", { sessionId: copy }).pipe(Effect.timeout("3 seconds"), Effect.ignore),
    ),
  );
});
