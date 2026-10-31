import type { DiffHunk } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  changeRows,
  changesUnder,
  discardWords,
  hunkLines,
  linesBetween,
  lineId,
  pickedHunks,
  sameDiff,
  unstagePaths,
} from "../src/features/git/model.ts";

describe("Source control's lists", () => {
  const changes = [
    { path: "src/app/main.ts", state: "modified" as const },
    { path: "src/app/view.ts", state: "added" as const },
    { path: "README.md", state: "modified" as const },
    { path: "docs/guide/intro.md", state: "untracked" as const },
  ];

  it("shows folders before files, a folder of one folder as one row", () => {
    const rows = changeRows(changes, new Set());
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.label}`)).toEqual([
      "docs/guide",
      "  intro.md",
      "src/app",
      "  main.ts",
      "  view.ts",
      "README.md",
    ]);
    expect(rows.find((row) => row.label === "src/app")).toMatchObject({ kind: "folder", count: 2 });
  });

  it("leaves a collapsed folder's files out", () => {
    expect(changeRows(changes, new Set(["src/app"])).map((row) => row.label)).toEqual([
      "docs/guide",
      "intro.md",
      "src/app",
      "README.md",
    ]);
  });

  it("finds the changes under a folder, and all of them under the top", () => {
    expect(changesUnder(changes, "src").map((change) => change.path)).toEqual([
      "src/app/main.ts",
      "src/app/view.ts",
    ]);
    expect(changesUnder(changes, "src/app/main.ts")).toHaveLength(1);
    expect(changesUnder(changes, "")).toHaveLength(4);
  });

  it("unstages a rename whole, its old name with it", () => {
    expect(
      unstagePaths([
        { path: "b.ts", state: "renamed", from: "a.ts" },
        { path: "c.ts", state: "modified" },
      ]),
    ).toEqual(["b.ts", "a.ts", "c.ts"]);
  });
});

describe("discarding", () => {
  it("says a new file is deleted, and a changed one loses what isn't staged", () => {
    expect(discardWords([{ path: "src/new.ts", state: "untracked" }], undefined)).toMatchObject({
      title: "Delete new.ts?",
      confirm: "Delete",
    });
    expect(discardWords([{ path: "src/app.ts", state: "modified" }], undefined)).toMatchObject({
      title: "Discard changes to app.ts?",
      confirm: "Discard",
    });
  });

  it("counts what a folder or everything loses", () => {
    const words = discardWords(
      [
        { path: "src/a.ts", state: "modified" },
        { path: "src/b.ts", state: "deleted" },
        { path: "src/c.ts", state: "untracked" },
      ],
      "src",
    );
    expect(words.title).toBe("Discard the changes in src?");
    expect(words.description).toBe(
      "2 files lose their unstaged changes, and 1 new file is deleted. This can't be undone.",
    );
    expect(
      discardWords(
        [
          { path: "x", state: "untracked" },
          { path: "y", state: "untracked" },
        ],
        "",
      ).title,
    ).toBe("Discard every change?");
  });
});

describe("picking lines", () => {
  const hunks: ReadonlyArray<DiffHunk> = [
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: "context", text: "a" },
        { kind: "removed", text: "b" },
        { kind: "added", text: "B" },
      ],
    },
    {
      oldStart: 10,
      newStart: 10,
      lines: [
        { kind: "added", text: "new" },
        { kind: "context", text: "j" },
      ],
    },
  ];

  it("runs from one changed line to another across hunks, unchanged lines left out", () => {
    expect(linesBetween(hunks, lineId(1, 0), lineId(0, 1))).toEqual(["0:1", "0:2", "1:0"]);
    expect(hunkLines(hunks, 0)).toEqual(["0:1", "0:2"]);
  });

  it("sends every line back, with the changed ones picked", () => {
    const picked = pickedHunks(hunks, new Set(["0:2", "1:1"]));
    expect(picked[0]!.lines.map((line) => line.picked)).toEqual([false, false, true]);
    // An unchanged line is never picked, whatever was asked.
    expect(picked[1]!.lines.map((line) => line.picked)).toEqual([false, false]);
    expect(picked[1]).toMatchObject({ oldStart: 10, newStart: 10 });
  });

  it("knows a diff read again that says the same, so its picks hold", () => {
    const again = structuredClone(hunks);
    expect(sameDiff({ hunks }, { hunks: again })).toBe(true);
    expect(sameDiff({ hunks }, { hunks: again, truncated: true })).toBe(false);
    const edited = hunks.map((hunk, at) =>
      at === 1 ? { ...hunk, lines: hunk.lines.map((line) => ({ ...line, text: `${line.text}!` })) } : hunk,
    );
    expect(sameDiff({ hunks }, { hunks: edited })).toBe(false);
    expect(sameDiff({ hunks }, { hunks: hunks.slice(1) })).toBe(false);
  });
});
