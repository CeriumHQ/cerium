import type { RestorePreview, RestoredFile } from "@cerium/protocol";

/** The `RPC_VERSION` that brought `PreviewRestore` and `RestoreBefore`; an older machine can't restore. */
export const RESTORE_VERSION = 11;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The user's messages a restore takes out, this one included. */
export const messagesLine = (messages: number): string =>
  messages <= 1
    ? "Removes this message and what came after it"
    : `Removes this message and ${messages === 2 ? "the one" : `the ${messages - 1}`} you sent after it`;

/** How the lead's conversation goes back, by its harness's name. */
export const conversationLine = (via: RestorePreview["conversation"], harness: string): string => {
  switch (via) {
    case "fork":
      return `${harness} picks up from just before it`;
    case "fresh":
      return `${harness} starts a new session`;
    case "replay":
      return `${harness} can't go back, so a new session is told the conversation up to here`;
  }
};

export const agentsLine = (agents: RestorePreview["agents"]): string =>
  `Stops ${plural(agents.length, "agent")}: ${agents.map((agent) => agent.role).join(", ")}`;

/** What a restore does to the files, in a line; the lists say which. */
export const filesLine = (files: NonNullable<RestorePreview["files"]>): string => {
  if ("unavailable" in files) return files.unavailable;
  if (files.restored.length === 0) {
    return files.kept.length === 0 ? "No files changed since, so none change now" : "Files stay as they are";
  }
  return `Puts back ${plural(files.restored.length, "file")} the thread's agents changed since`;
};

/** Why the preview couldn't be read, as the backend told it. */
export const previewFailure = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Couldn't check what a restore would undo.";

/** What putting a file back does to it. */
export const undoLabel: Record<RestoredFile["undo"], string> = {
  edit: "edit undone",
  create: "removed",
  delete: "brought back",
};
