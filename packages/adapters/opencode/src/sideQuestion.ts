import { HarnessFailure, type CompletionUsage, type SideQuestionRequest } from "@cerium/harness";
import { Effect, Schema } from "effect";

import { completionPrompt } from "./complete.ts";
import { call, type OpenCodeClient } from "./host.ts";

/**
 * What `session.generate` answers. Servers newer than the pinned client also report the call's tokens
 * and cost, which are read when present.
 */
const Generated = Schema.Struct({
  text: Schema.String,
  tokens: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      reasoning: Schema.optionalKey(Schema.Finite),
      cache: Schema.optionalKey(Schema.Struct({ read: Schema.Finite, write: Schema.Finite })),
    }),
  ),
  cost: Schema.optionalKey(Schema.Finite),
});
const decodeGenerated = Schema.decodeUnknownEffect(Generated);

const count = (value: number) => Math.max(0, Math.round(value));

/** The call's usage, counted like a turn's steps: cache writes are input, reasoning is output. */
export const generatedUsage = (reply: typeof Generated.Type): CompletionUsage => {
  const { tokens, cost } = reply;
  if (tokens === undefined) return { inputTokens: 0, outputTokens: 0, unreported: true };
  return {
    inputTokens: count(tokens.input + (tokens.cache?.write ?? 0)),
    outputTokens: count(tokens.output + (tokens.reasoning ?? 0)),
    cachedInputTokens: count(tokens.cache?.read ?? 0),
    ...(cost !== undefined && cost > 0 ? { costUsd: cost } : {}),
  };
};

/**
 * Asks a session's conversation one question with `session.generate`, which OpenCode documents as
 * transient text from the session's context that leaves its history as it was. It runs without tools,
 * so it can't change anything, and on the session's own model. OpenCode adds its tokens and cost to the
 * session's totals.
 */
export const askOpenCodeSideQuestion = Effect.fn("OpenCodeAdapter.sideQuestion")(function* (
  client: OpenCodeClient,
  request: SideQuestionRequest,
) {
  const reply = yield* call("answer the side question", (signal) =>
    client.session.generate({ sessionID: request.sessionId, prompt: completionPrompt(request) }, { signal }),
  ).pipe(
    Effect.flatMap(decodeGenerated),
    Effect.mapError((cause) =>
      cause instanceof HarnessFailure
        ? cause
        : new HarnessFailure({
            provider: "opencode",
            message: "Unexpected `session.generate` response",
            cause,
          }),
    ),
  );
  request.onUsage?.(generatedUsage(reply));
  if (reply.text.trim() !== "") return reply.text;
  return yield* new HarnessFailure({
    provider: "opencode",
    message: "OpenCode's reply was empty",
    cause: reply,
  });
});
