// Turns a tool call's file edit into lines a person can review before approving it.

export interface DiffLine {
  readonly kind: "context" | "removed" | "added";
  readonly text: string;
}

/** Unchanged lines kept on each side of a change, enough to place it. */
const CONTEXT = 2;

const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

/**
 * A find-and-replace edit as diff lines: the lines both sides share at the start and end become
 * context around what is removed and what is added.
 */
export const editLines = (before: string, after: string): ReadonlyArray<DiffLine> => {
  const removed = linesOf(before);
  const added = linesOf(after);
  let start = 0;
  while (start < removed.length && start < added.length && removed[start] === added[start]) start++;
  let end = 0;
  while (
    end < removed.length - start &&
    end < added.length - start &&
    removed[removed.length - 1 - end] === added[added.length - 1 - end]
  ) {
    end++;
  }
  const line = (kind: DiffLine["kind"]) => (text: string) => ({ kind, text });
  return [
    ...removed.slice(Math.max(0, start - CONTEXT), start).map(line("context")),
    ...removed.slice(start, removed.length - end).map(line("removed")),
    ...added.slice(start, added.length - end).map(line("added")),
    ...removed.slice(removed.length - end, removed.length - end + CONTEXT).map(line("context")),
  ];
};

export interface FileEdit {
  readonly before: string;
  readonly after: string;
}

const field = (value: unknown, key: string): string | undefined => {
  const found =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === "string" ? found : undefined;
};

/** A replacement's text, as `old_string` (Claude Code) or `oldString` (OpenCode). */
const before = (edit: unknown) => field(edit, "old_string") ?? field(edit, "oldString");
const after = (edit: unknown) => field(edit, "new_string") ?? field(edit, "newString");

/**
 * The edits a tool call's input describes: one replacement, several (`edits`), or a whole new file
 * (`content`). None for anything else.
 */
export const fileEdits = (input: unknown): ReadonlyArray<FileEdit> => {
  const edits =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)["edits"] : undefined;
  if (Array.isArray(edits)) {
    return edits.map((edit: unknown) => ({ before: before(edit) ?? "", after: after(edit) ?? "" }));
  }
  const removed = before(input);
  const added = after(input);
  if (removed !== undefined || added !== undefined) return [{ before: removed ?? "", after: added ?? "" }];
  const content = field(input, "content");
  return content === undefined ? [] : [{ before: "", after: content }];
};
