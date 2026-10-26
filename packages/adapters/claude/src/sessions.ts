import {
  getSessionMessages,
  listSessions,
  type SDKMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure, type PastHistory, type PastSession, type PastTurn } from "@cerium/harness";
import { Effect } from "effect";

import { isPrompt } from "./fork.ts";
import { ClaudeTranslator } from "./translate.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/**
 * The user's Claude Code sessions, from the SDK's own listing of its transcripts. Sessions started
 * through an SDK (Cerium's among them) are left out, like Claude Code's own `/resume` leaves them out,
 * and so are those with no folder recorded: Claude Code resumes a session only in its own folder.
 */
export const listClaudeSessions = Effect.tryPromise({
  try: () => listSessions({ includeProgrammatic: false }),
  catch: failure("Could not list the Claude sessions"),
}).pipe(
  Effect.map((sessions) =>
    sessions.flatMap((session): ReadonlyArray<PastSession> => {
      if (session.cwd === undefined || session.cwd === "") return [];
      const title = (session.customTitle ?? session.summary ?? session.firstPrompt ?? "").trim();
      return [
        {
          id: session.sessionId,
          cwd: session.cwd,
          title: title === "" ? "Claude Code session" : title,
          updatedAt: session.lastModified,
          ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
          ...(session.fileSize === undefined ? {} : { bytes: session.fileSize }),
        },
      ];
    }),
  ),
  Effect.withSpan("ClaudeAdapter.listSessions"),
);

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;

/**
 * What the user typed in a prompt: its text, a slash command as they typed it, or nothing for what
 * Claude Code writes itself as a user message (a command's output, its caveats).
 */
export const promptText = (message: SessionMessage): string | undefined => {
  const content = (message.message as { readonly content?: unknown } | null)?.content;
  const blocks: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }> =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? (content as ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>)
        : [];
  const text = blocks
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n\n")
    .trim();
  const command = COMMAND.exec(text)?.[1];
  if (command !== undefined) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
    return args ? `${command} ${args}` : command;
  }
  if (text.startsWith("<local-command-") || text.startsWith("Caveat: ")) return undefined;
  if (text === "" && blocks.some((block) => block.type === "image")) return "(image)";
  return text;
};

/**
 * A transcript as turns: each of the user's prompts with the messages that answer it, translated by
 * the same translator a live session uses. What came before the first prompt (a resumed session's
 * summary) is left out.
 */
export const toPastHistory = (messages: ReadonlyArray<SessionMessage>): PastHistory => {
  const translator = new ClaudeTranslator();
  const turns: Array<{ prompt: string; events: Array<PastTurn["events"][number]> }> = [];
  let model: string | undefined;
  for (const message of messages) {
    if (isPrompt(message)) {
      const prompt = promptText(message);
      if (prompt !== undefined) turns.push({ prompt, events: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined || message.type === "system") continue;
    if (message.type === "assistant") {
      const used = (message.message as { readonly model?: unknown } | null)?.model;
      if (typeof used === "string" && used !== "<synthetic>") model = used;
    }
    // The transcript keeps the API message the SDK would have streamed.
    turn.events.push(...translator.translate(message as unknown as SDKMessage));
  }
  return { ...(model === undefined ? {} : { model }), turns };
};

/** A Claude Code session's conversation, read from its transcript with the SDK. */
export const readClaudeSession = Effect.fn("ClaudeAdapter.readSession")(function* (session: PastSession) {
  const messages = yield* Effect.tryPromise({
    try: () => getSessionMessages(session.id, session.cwd === undefined ? {} : { dir: session.cwd }),
    catch: failure("Could not read the Claude session"),
  });
  return toPastHistory(messages);
});
