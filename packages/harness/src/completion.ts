import type { ProviderId } from "@cerium/protocol";
import { Effect, Stream } from "effect";

import { HarnessFailure, type AgentSession } from "./adapter.ts";

/** What a reply's turn has said so far: its last completed message, or why it failed. */
interface Reply {
  readonly text?: string;
  readonly error?: string;
}

/**
 * Sends one turn and resolves with its last completed message, for harnesses whose quickest answer is
 * still a session's. Fails when the turn ends without one.
 */
export const replyTo = (session: AgentSession, provider: ProviderId, text: string) =>
  Effect.gen(function* () {
    yield* session.send(text);
    const reply = yield* session.events.pipe(
      Stream.takeUntil((event) => event.payload._tag === "TurnCompleted"),
      Stream.runFold(
        (): Reply => ({}),
        (current, { payload }): Reply =>
          payload._tag === "MessageCompleted" && payload.text.trim() !== ""
            ? { ...current, text: payload.text }
            : payload._tag === "AgentError"
              ? { ...current, error: payload.message }
              : current,
      ),
    );
    if (reply.text !== undefined) return reply.text;
    return yield* new HarnessFailure({
      provider,
      message: reply.error ?? "The reply ended without a message",
      cause: reply,
    });
  });
