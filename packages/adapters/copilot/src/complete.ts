import type { CompletionRequest } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Effect, Stream } from "effect";
import { resolve } from "node:path";

import { SIGN_IN } from "./manifest.ts";
import { failure, type CopilotHost } from "./rpc.ts";
import { startCopilotSession } from "./session.ts";

export const completeWithCopilot = Effect.fn("CopilotAdapter.complete")(function* (
  host: CopilotHost,
  request: CompletionRequest,
  models: ReadonlyArray<ModelInfo>,
) {
  const effort = models.find(({ id }) => id === request.model)?.efforts[0];
  const session = yield* startCopilotSession(host, {
    options: {
      cwd: resolve(request.cwd),
      model: request.model,
      access: "readOnly",
      mcpServers: {},
      includeUserMcpServers: false,
      ...(effort === undefined ? {} : { effort }),
    },
    models,
    completionInstructions: request.instructions,
  });

  let text = "";
  let error: string | undefined;
  let reported = false;
  const terminal = yield* session.send(request.prompt).pipe(
    Effect.andThen(
      session.events.pipe(
        Stream.map(({ payload }) => payload),
        Stream.tap((payload) =>
          Effect.sync(() => {
            switch (payload._tag) {
              case "MessageCompleted":
                text = payload.text;
                break;
              case "AgentError":
              case "LimitReached":
                error = payload.message;
                break;
              case "AuthRequired":
                error = SIGN_IN;
                break;
              case "UsageReported": {
                const { inputTokens, outputTokens, cachedInputTokens, unreported } = payload;
                reported = true;
                request.onUsage?.({
                  inputTokens,
                  outputTokens,
                  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                  ...(unreported === undefined ? {} : { unreported }),
                });
                break;
              }
            }
          }),
        ),
        Stream.filter((payload) => payload._tag === "TurnCompleted"),
        Stream.runHead,
      ),
    ),
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () => Effect.fail(failure("GitHub Copilot CLI did not finish its completion")(undefined)),
    }),
    Effect.ensuring(
      Effect.sync(() => {
        if (!reported) request.onUsage?.({ inputTokens: 0, outputTokens: 0, unreported: true });
      }),
    ),
  );
  if (terminal._tag === "None" || terminal.value.stopReason !== "completed" || error) {
    return yield* failure(error ?? "GitHub Copilot CLI could not complete the request")(undefined);
  }
  return text;
});
