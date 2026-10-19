import type { DiffHunk } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";
import { bundledLanguages } from "shiki/langs";

import { languageOf } from "../src/features/viewer/language.ts";
import {
  byteSize,
  changedWords,
  diffStats,
  fileKey,
  fileOfKey,
  isFileKey,
  numberHunks,
  pickView,
  pieces,
  renderedKind,
  replacedPairs,
  splitRows,
  viewsOf,
} from "../src/features/viewer/model.ts";
import { htmlDocument, relativeTarget, sizedSvg } from "../src/features/viewer/previews.tsx";

describe("file tabs", () => {
  it("keys a file by its folder and path, and reads both back", () => {
    const key = fileKey("C:\\Work\\app", "src/ui/App.tsx");
    expect(isFileKey(key)).toBe(true);
    expect(fileOfKey(key)).toEqual({ root: "C:\\Work\\app", path: "src/ui/App.tsx" });
  });

  it("leaves threads' and drafts' keys alone", () => {
    expect(fileOfKey("thr_01a1563b")).toBeUndefined();
    expect(fileOfKey("new:1234")).toBeUndefined();
    expect(fileOfKey(undefined)).toBeUndefined();
    expect(fileOfKey("file:no-path")).toBeUndefined();
  });
});

describe("views", () => {
  it("offers a changed file's changes first, and rendered files as they render and as written", () => {
    expect(viewsOf("src/a.ts", undefined, "Text").map((view) => view.value)).toEqual(["file"]);
    expect(viewsOf("src/a.ts", "modified", "Text").map((view) => view.value)).toEqual(["diff", "file"]);
    expect(viewsOf("README.md", "untracked", "Text").map((view) => view.value)).toEqual([
      "diff",
      "rendered",
      "file",
    ]);
    expect(viewsOf("page.html", undefined, "Text").map((view) => view.label)).toEqual(["Preview", "Source"]);
    expect(viewsOf("gone.ts", "deleted", "Missing").map((view) => view.value)).toEqual(["diff"]);
    expect(viewsOf("pic.png", "added", "Media").map((view) => view.value)).toEqual(["diff", "file"]);
  });

  it("opens rendered when it can, keeps the user's choice while it's offered", () => {
    const views = viewsOf("README.md", "modified", "Text");
    expect(pickView(views, undefined)).toBe("rendered");
    expect(pickView(views, "diff")).toBe("diff");
    expect(pickView(viewsOf("a.ts", undefined, "Text"), "diff")).toBe("file");
  });

  it("knows what renders by extension", () => {
    expect(renderedKind("docs/Guide.MD")).toBe("markdown");
    expect(renderedKind("index.htm")).toBe("html");
    expect(renderedKind("logo.svg")).toBe("svg");
    expect(renderedKind("main.ts")).toBeUndefined();
  });

  it("says sizes the way people read them", () => {
    expect(byteSize(512)).toBe("512 B");
    expect(byteSize(1536)).toBe("1.5 KB");
    expect(byteSize(40 * 1024 * 1024)).toBe("40 MB");
  });
});

describe("languages", () => {
  const known = (id: string) => Object.hasOwn(bundledLanguages, id);

  it("names the grammar by extension, whole name or alias", () => {
    expect(languageOf("src/App.tsx", known)).toBe("tsx");
    expect(languageOf("a/b.mts", known)).toBe("typescript");
    expect(languageOf("script.PS1", known)).toBe("powershell");
    expect(languageOf("Dockerfile", known)).toBe("docker");
    expect(languageOf(".env.local", known)).toBe("dotenv");
    expect(languageOf("tsconfig.json", known)).toBe("jsonc");
    expect(languageOf("main.rs", known)).toBe("rust");
    expect(languageOf("style.scss", known)).toBe("scss");
  });

  it("leaves what it doesn't know plain", () => {
    expect(languageOf("LICENSE", known)).toBe("txt");
    expect(languageOf("data.xyz123", known)).toBe("txt");
  });
});

const hunk = (oldStart: number, newStart: number, lines: DiffHunk["lines"]): DiffHunk => ({
  oldStart,
  newStart,
  lines,
});

describe("diffs", () => {
  const hunks = [
    hunk(3, 3, [
      { kind: "context", text: "a" },
      { kind: "removed", text: "const x = 1;" },
      { kind: "added", text: "const x = 2;" },
      { kind: "added", text: "const y = 3;" },
      { kind: "context", text: "b" },
    ]),
    hunk(20, 21, [{ kind: "removed", text: "gone" }]),
  ];

  it("numbers each side's lines and counts the unchanged stretches between hunks", () => {
    const numbered = numberHunks(hunks);
    const [first, second] = numbered.hunks;
    expect(first!.gapBefore).toBe(2);
    expect(first!.lines.map((line) => [line.old, line.new])).toEqual([
      [3, 3],
      [4, undefined],
      [undefined, 4],
      [undefined, 5],
      [5, 6],
    ]);
    // The first hunk ends after old line 5; the second starts at 20.
    expect(second!.gapBefore).toBe(14);
    expect(numbered.oldText).toBe("a\nconst x = 1;\nb\ngone");
    expect(numbered.newText).toBe("a\nconst x = 2;\nconst y = 3;\nb");
  });

  it("starts a new file's hunk without a gap", () => {
    const fresh = numberHunks([hunk(0, 1, [{ kind: "added", text: "x" }])]);
    expect(fresh.hunks[0]!.gapBefore).toBe(0);
  });

  it("counts what was added and removed", () => {
    expect(diffStats(hunks)).toEqual({ added: 2, removed: 2 });
  });

  it("lays removals beside the additions that replaced them", () => {
    const rows = splitRows(numberHunks(hunks).hunks[0]!.lines);
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ["a", "a"],
      ["const x = 1;", "const x = 2;"],
      [undefined, "const y = 3;"],
      ["b", "b"],
    ]);
    expect([...replacedPairs(hunks[0]!.lines)]).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it("picks out the words that changed within a line", () => {
    expect(changedWords("const x = 1;", "const x = 2;")).toEqual({ removed: [[10, 11]], added: [[10, 11]] });
    expect(changedWords("return value", "return otherValue + 1")).toEqual({
      removed: [[7, 12]],
      added: [[7, 21]],
    });
    // A line rewritten whole has no words worth picking out.
    expect(changedWords("alpha beta", "gamma delta")).toBeUndefined();
  });

  it("cuts highlighted tokens where the changed words start and end", () => {
    expect(
      pieces("const x = 2;", [["const", "var(--k)"], [" x = "], ["2", "var(--n)"], [";"]], [[8, 11]]),
    ).toEqual([
      { text: "const", color: "var(--k)", marked: false },
      { text: " x ", marked: false },
      { text: "= ", marked: true },
      { text: "2", color: "var(--n)", marked: true },
      { text: ";", marked: false },
    ]);
    expect(pieces("plain", undefined, [])).toEqual([{ text: "plain", marked: false }]);
  });
});

describe("previews", () => {
  it("finds a Markdown file's relative images in the folder, and leaves links elsewhere alone", () => {
    expect(relativeTarget("shot.png", "docs/README.md")).toBe("docs/shot.png");
    expect(relativeTarget("../assets/My%20Logo.svg?raw", "docs/README.md")).toBe("assets/My Logo.svg");
    expect(relativeTarget("./a/b.gif", "README.md")).toBe("a/b.gif");
    expect(relativeTarget(".github/media/logo.svg", "README.md")).toBe(".github/media/logo.svg");
    expect(relativeTarget("/media/logo.svg", "docs/README.md")).toBe("media/logo.svg");
    expect(relativeTarget("../../out.png", "docs/README.md")).toBeUndefined();
    expect(relativeTarget("https://example.com/a.png", "README.md")).toBeUndefined();
    expect(relativeTarget("data:image/png;base64,AA", "README.md")).toBeUndefined();
  });

  it("sizes an SVG that sets no size of its own from its viewBox", () => {
    expect(sizedSvg('<svg xmlns="x" viewBox="-30 -780 4558 860"><g/></svg>')).toBe(
      '<svg width="4558" height="860" xmlns="x" viewBox="-30 -780 4558 860"><g/></svg>',
    );
    const sized = '<svg width="24" viewBox="0 0 24 24"/>';
    expect(sizedSvg(sized)).toBe(sized);
    expect(sizedSvg("<svg><g/></svg>")).toBe("<svg><g/></svg>");
  });

  it("puts a policy that admits no script or request at the head of a page", () => {
    const policy = "default-src 'none'";
    const withHead = htmlDocument("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(withHead.indexOf(policy)).toBeLessThan(withHead.indexOf("<title>"));
    expect(withHead.startsWith("<!doctype html>")).toBe(true);
    const bare = htmlDocument("<!DOCTYPE html><p>hi</p>");
    expect(bare.startsWith("<!DOCTYPE html><head><meta")).toBe(true);
    expect(htmlDocument("<p>hi</p>").startsWith("<head><meta")).toBe(true);
  });
});
