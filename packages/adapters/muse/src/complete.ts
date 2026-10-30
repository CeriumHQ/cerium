import { replyTo, type CompletionRequest } from "@cerium/harness";
import { Effect } from "effect";

import { startMuseSession } from "./session.ts";

/**
 * Muse answers only inside a session, so a completion gets the quietest one: a read-only host that
 * saves nothing, without MCP servers or the user's own, at the model's lowest effort, with the
 * request's instructions as its developer prompt. Ends with its answer.
 */
export const completeWithMuse = Effect.fn("MuseAdapter.complete")(function* (
  executablePath: string,
  request: CompletionRequest,
) {
  const session = yield* startMuseSession(
    executablePath,
    {
      cwd: request.cwd,
      model: request.model,
      effort: "minimal",
      access: "readOnly",
      mcpServers: {},
      includeUserMcpServers: false,
      appendSystemPrompt: request.instructions,
    },
    { ephemeral: true },
  );
  return yield* replyTo(session, "muse", request.prompt, request.onUsage);
}, Effect.scoped);
