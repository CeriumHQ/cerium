import { describe, expect, it } from "@effect/vitest";

import { editLines, fileEdits } from "../src/features/transcript/diff.ts";

describe("editLines", () => {
  it("shows a one-line change as a removal and an addition", () => {
    expect(editLines("const a = 1;", "const a = 2;")).toEqual([
      { kind: "removed", text: "const a = 1;" },
      { kind: "added", text: "const a = 2;" },
    ]);
  });

  it("keeps up to two shared lines on each side as context", () => {
    const before = ["one", "two", "three", "old", "four", "five", "six"].join("\n");
    const after = ["one", "two", "three", "new", "four", "five", "six"].join("\n");
    expect(editLines(before, after)).toEqual([
      { kind: "context", text: "two" },
      { kind: "context", text: "three" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "context", text: "four" },
      { kind: "context", text: "five" },
    ]);
  });

  it("shows a new file as additions only", () => {
    expect(editLines("", "a\nb")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });

  it("shows an insertion without inventing a removal", () => {
    expect(editLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "added", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });
});

describe("fileEdits", () => {
  it("reads a single replacement", () => {
    expect(fileEdits({ file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual([
      { before: "x", after: "y" },
    ]);
  });

  it("reads OpenCode's replacement", () => {
    expect(fileEdits({ path: "a.ts", oldString: "x", newString: "y" })).toEqual([
      { before: "x", after: "y" },
    ]);
  });

  it("reads several replacements", () => {
    expect(
      fileEdits({
        file_path: "a.ts",
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "p", new_string: "q" },
        ],
      }),
    ).toEqual([
      { before: "x", after: "y" },
      { before: "p", after: "q" },
    ]);
  });

  it("reads a whole new file", () => {
    expect(fileEdits({ file_path: "a.ts", content: "hello" })).toEqual([{ before: "", after: "hello" }]);
  });

  it("finds nothing in other tools' input", () => {
    expect(fileEdits({ command: "ls" })).toEqual([]);
    expect(fileEdits(undefined)).toEqual([]);
  });
});
