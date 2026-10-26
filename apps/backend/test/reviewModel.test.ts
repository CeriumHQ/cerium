import type { CatalogEntry } from "@cerium/orchestrator";
import { assert, describe, it } from "@effect/vitest";

import {
  addedFile,
  defaultReviewer,
  numberedDiff,
  readReview,
  reviewPrompt,
  splitFiles,
} from "../src/reviewModel.ts";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,4 @@ export function a() {",
  "   const x = 1;",
  "-  const y = 2;",
  "+  const y = 3;",
  "   return x + y;",
  " }",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-gone",
  "-too",
  "",
].join("\n");

describe("splitFiles", () => {
  it("splits a diff of several files, naming a deleted file by its old path", () => {
    const files = splitFiles(patch);
    assert.deepStrictEqual(
      files.map((file) => file.path),
      ["src/a.ts", "old.txt"],
    );
    assert.strictEqual(files[0]?.hunks[0]?.newStart, 10);
    assert.lengthOf(files[0]?.hunks[0]?.lines ?? [], 5);
    assert.deepStrictEqual(splitFiles(""), []);
  });
});

describe("numberedDiff", () => {
  it("numbers new and unchanged lines on the new side and removed ones on the old", () => {
    const { text, left } = numberedDiff(splitFiles(patch));
    assert.include(text, "### src/a.ts");
    assert.include(text, "  10:   const x = 1;");
    assert.include(text, "- old 11:   const y = 2;");
    assert.include(text, "+ 11:   const y = 3;");
    assert.include(text, "  12:   return x + y;");
    assert.deepStrictEqual(left, []);
  });

  it("names the files past its limit instead of showing them", () => {
    const files = [addedFile("a.ts", "x".repeat(50)), addedFile("b.ts", "y".repeat(50))];
    const { text, left } = numberedDiff(files, 70);
    assert.include(text, "a.ts");
    assert.deepStrictEqual(left, ["b.ts"]);
    assert.include(reviewPrompt({ label: "2 files", author: undefined, files }), '"findings"');
  });
});

describe("readReview", () => {
  const files = splitFiles(patch);

  it("reads findings from the last JSON block, with the lines each covers", () => {
    const reply = [
      "I looked at it.",
      "```json",
      JSON.stringify({
        summary: "One bug.",
        findings: [
          {
            path: "./src/a.ts",
            line: 11,
            side: "new",
            severity: "critical",
            title: "y changed",
            body: "Why 3?",
          },
          { path: "src/a.ts", line: 11, side: "old", severity: "nit", title: "Removed y" },
          { path: "elsewhere.ts", line: 4, title: "Not in the diff", body: "Still worth saying" },
          { path: "src/a.ts", title: "", body: "" },
        ],
      }),
      "```",
    ].join("\n");
    const { summary, findings } = readReview(reply, files);
    assert.strictEqual(summary, "One bug.");
    assert.lengthOf(findings, 3);
    assert.deepInclude(findings[0], { id: "f1", path: "src/a.ts", start: 11, end: 11, severity: "high" });
    assert.deepStrictEqual(findings[0]?.lines, [{ marker: "+", text: "  const y = 3;", number: 11 }]);
    assert.deepStrictEqual(findings[1]?.lines, [{ marker: "-", text: "  const y = 2;", number: 11 }]);
    assert.strictEqual(findings[1]?.severity, "low");
    assert.strictEqual(findings[1]?.body, "");
    assert.deepInclude(findings[2], { path: "elsewhere.ts", lines: [] });
  });

  it("reads a bare object, and a reply without one as a summary", () => {
    assert.lengthOf(
      readReview('Done. {"findings":[{"path":"src/a.ts","line":10,"endLine":12,"title":"x"}]}', files)
        .findings[0]?.lines ?? [],
      3,
    );
    assert.deepStrictEqual(readReview("Looks fine to me.", files), {
      summary: "Looks fine to me.",
      findings: [],
    });
    assert.deepStrictEqual(readReview("", files), { summary: undefined, findings: [] });
  });
});

describe("defaultReviewer", () => {
  const roster: ReadonlyArray<CatalogEntry> = [
    { alias: "opus", provider: "claude", model: "opus", description: "" },
    { alias: "sonnet", provider: "claude", model: "sonnet", description: "" },
    { alias: "luna", provider: "codex", model: "gpt-6-luna", effort: "high", description: "" },
  ];

  it("prefers another harness, then another model, then any", () => {
    assert.deepStrictEqual(defaultReviewer(roster, { provider: "claude", model: "opus" }), {
      provider: "codex",
      model: "gpt-6-luna",
      effort: "high",
    });
    assert.deepStrictEqual(defaultReviewer(roster.slice(0, 2), { provider: "claude", model: "opus" }), {
      provider: "claude",
      model: "sonnet",
    });
    assert.isUndefined(defaultReviewer([], { provider: "claude", model: "opus" }));
  });
});
