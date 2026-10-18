import type { Mention } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { appendSegments, draftText, segmentsOf, type Segment } from "../src/features/composer/draft.ts";
import { fileTargets, isOpenableLink } from "../src/features/transcript/menus.ts";
import { relativePath } from "../src/features/transcript/paths.ts";

const file = (path: string, folder = false): Mention => ({ _tag: "FileMention", path, folder });
const skill: Mention = { _tag: "SkillMention", name: "review" };
const text = (value: string): Segment => ({ kind: "text", text: value });
const chip = (mention: Mention): Segment => ({ kind: "mention", mention });

describe("relativePath", () => {
  it("gives the path inside the folder with forward slashes", () => {
    expect(relativePath("C:\\work\\app\\src\\main.ts", "C:\\work\\app")).toBe("src/main.ts");
    expect(relativePath("/home/me/app/docs/", "/home/me/app/")).toBe("docs");
  });

  it("ignores case in Windows paths only", () => {
    expect(relativePath("c:\\Work\\App\\README.md", "C:\\work\\app")).toBe("README.md");
    expect(relativePath("/home/Me/app/a.ts", "/home/me/app")).toBeUndefined();
  });

  it("is undefined outside the folder, for the folder itself, or without one", () => {
    expect(relativePath("C:\\work\\apple\\a.ts", "C:\\work\\app")).toBeUndefined();
    expect(relativePath("C:\\work\\app\\..\\other.ts", "C:\\work\\app")).toBeUndefined();
    expect(relativePath("C:\\work\\app", "C:\\work\\app")).toBeUndefined();
    expect(relativePath("C:\\work\\app\\a.ts", undefined)).toBeUndefined();
  });
});

describe("fileTargets", () => {
  it("resolves a relative path and tags it", () => {
    expect(fileTargets("src/main.ts", false, "C:\\work\\app")).toEqual({
      location: "C:\\work\\app\\src\\main.ts",
      relative: "src/main.ts",
      mention: file("src/main.ts"),
    });
    expect(fileTargets("./docs", true, "C:\\work\\app").mention).toEqual(file("docs", true));
  });

  it("only copies the path of a file outside the thread's folder", () => {
    expect(fileTargets("C:\\Users\\me\\.cerium\\pasted\\a.txt", false, "C:\\work\\app")).toEqual({
      location: "C:\\Users\\me\\.cerium\\pasted\\a.txt",
    });
  });

  it("offers nothing for a relative path without a folder", () => {
    expect(fileTargets("src/main.ts", false, undefined)).toEqual({});
  });
});

describe("isOpenableLink", () => {
  it("opens only https", () => {
    expect(isOpenableLink("https://effect.website/docs")).toBe(true);
    expect(isOpenableLink("http://example.com")).toBe(false);
    expect(isOpenableLink("file:///C:/a.txt")).toBe(false);
    expect(isOpenableLink("not a url")).toBe(false);
  });
});

describe("segmentsOf", () => {
  it("turns each mention's token back into its chip", () => {
    const segments = segmentsOf("Look at @src/ and @src/main.ts with $review", [
      file("src", true),
      file("src/main.ts"),
      skill,
    ]);
    expect(segments).toEqual([
      text("Look at "),
      chip(file("src", true)),
      text(" and "),
      chip(file("src/main.ts")),
      text(" with "),
      chip(skill),
    ]);
    expect(draftText(segments)).toBe("Look at @src/ and @src/main.ts with $review");
  });

  it("leaves text without mentions as it is", () => {
    expect(segmentsOf("Costs $5 at @noon", [])).toEqual([text("Costs $5 at @noon")]);
    expect(segmentsOf("", [])).toEqual([]);
  });
});

describe("appendSegments", () => {
  it("replaces an empty or blank draft", () => {
    expect(appendSegments([], [text("hi")])).toEqual([text("hi")]);
    expect(appendSegments([text("  ")], [chip(skill)])).toEqual([chip(skill)]);
  });

  it("starts what's added on a line of its own", () => {
    expect(appendSegments([text("First  ")], [text("second")])).toEqual([text("First\nsecond")]);
    expect(appendSegments([text("First\n")], [text("second")])).toEqual([text("First\nsecond")]);
    expect(appendSegments([chip(skill)], [text("second")])).toEqual([chip(skill), text("\nsecond")]);
  });
});
