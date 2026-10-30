import { HarnessFailure, type SideQuestionRequest } from "@cerium/harness";
import { Effect } from "effect";

import { answeringConfig, answerOn } from "./complete.ts";
import { connect } from "./rpc.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/**
 * Asks a copy of a Codex thread one question. `thread/fork` with `ephemeral` copies the thread's
 * history into a thread kept only in memory, so nothing joins the user's list of threads; it runs
 * read-only and is never asked to approve anything, so a command that would change something fails
 * instead of waiting. The shell stays, to read files with. The copy goes with the app-server.
 */
export const askCodexSideQuestion = Effect.fn("CodexAdapter.sideQuestion")(function* (
  executablePath: string,
  request: SideQuestionRequest,
) {
  const server = yield* connect(executablePath, request.cwd);
  const { config } = yield* server
    .request("config/read", { cwd: request.cwd })
    .pipe(Effect.mapError(failure("Could not prepare a Codex thread")));
  const userMcpServers = Object.keys(
    (config as { readonly mcp_servers?: Record<string, unknown> | null }).mcp_servers ?? {},
  );
  const { thread } = yield* server
    .request("thread/fork", {
      threadId: request.sessionId,
      cwd: request.cwd,
      model: request.model,
      ephemeral: true,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: request.instructions,
      config: answeringConfig(userMcpServers, true),
    })
    .pipe(Effect.mapError(failure("Could not fork the Codex thread")));
  return yield* answerOn(server, thread.id, request.prompt, request.onUsage);
}, Effect.scoped);
