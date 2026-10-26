import { forkSession, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure, type ForkRequest, type TurnRef } from "@cerium/harness";
import { Effect } from "effect";

/** What Claude Code writes as a user message when a turn is interrupted; no turn of Cerium's. */
const INTERRUPTED = /^\[Request interrupted by user/;

/** Whether a transcript message is a turn's prompt: the user's text or images, not a tool's result. */
export const isPrompt = (message: SessionMessage): boolean => {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return false;
  const content = (message.message as { readonly content?: unknown } | null)?.content;
  if (typeof content === "string") return !INTERRUPTED.test(content);
  if (!Array.isArray(content)) return false;
  const blocks = content as ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
  if (blocks.some((block) => block.type === "tool_result")) return false;
  const text = blocks.find((block) => block.type === "text")?.text;
  return typeof text === "string" ? !INTERRUPTED.test(text) : blocks.some((block) => block.type === "image");
};

/**
 * The last message a copy ending before `turn` keeps: the one before its prompt, which carries the
 * turn's id as its `uuid` when Cerium sent it. A session forked before has fresh ids, so the turn is
 * found by its place among the prompts instead.
 */
export const lastKept = (messages: ReadonlyArray<SessionMessage>, turn: TurnRef): string | undefined => {
  let at = turn.id === undefined ? -1 : messages.findIndex((message) => message.uuid === turn.id);
  if (at === -1) {
    const prompts = messages.flatMap((message, index) => (isPrompt(message) ? [index] : []));
    at = prompts[turn.index] ?? -1;
  }
  return at > 0 ? messages[at - 1]?.uuid : undefined;
};

/** Copies a Claude Code session up to the turn before `before` with the SDK's own `forkSession`. */
export const forkClaudeSession = Effect.fn("ClaudeAdapter.fork")(function* (request: ForkRequest) {
  const failure = (message: string) => (cause: unknown) =>
    new HarnessFailure({ provider: "claude", message, cause });
  const messages = yield* Effect.tryPromise({
    try: () => getSessionMessages(request.sessionId, { dir: request.cwd, includeSystemMessages: true }),
    catch: failure("Could not read the Claude session"),
  });
  const upToMessageId = lastKept(messages, request.before);
  if (upToMessageId === undefined) {
    return yield* new HarnessFailure({
      provider: "claude",
      message: "Could not find that message in the Claude session.",
      cause: undefined,
    });
  }
  const { sessionId } = yield* Effect.tryPromise({
    try: () => forkSession(request.sessionId, { dir: request.cwd, upToMessageId }),
    catch: failure("Could not fork the Claude session"),
  });
  return sessionId;
});
