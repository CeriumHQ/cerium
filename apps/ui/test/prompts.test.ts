import type { SavedPrompt } from "@cerium/protocol";
import {
  matchPrompts,
  movePrompt,
  promptName,
  visiblePrompts,
  withPrompt,
  withoutPrompt,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { triggerAt } from "../src/features/composer/draft.ts";

const prompt = (id: string, name: string, extra: Partial<SavedPrompt> = {}): SavedPrompt => ({
  id,
  name,
  text: name,
  createdAt: 1,
  ...extra,
});

const global = prompt("g", "Summarise the changes");
const project = prompt("p", "Review this diff", { folder: "C:/code/app" });
const other = prompt("o", "Other project notes", { folder: "C:/code/other" });
const all = [global, project, other];

describe("triggerAt", () => {
  it("opens on / at the very start of the message", () => {
    expect(triggerAt("/", true)).toEqual({ char: "/", query: "", start: 0 });
    expect(triggerAt("/rev", true)).toEqual({ char: "/", query: "rev", start: 0 });
  });

  it("ignores / anywhere else", () => {
    expect(triggerAt("/rev", false)).toBeUndefined();
    expect(triggerAt("a /rev", true)).toBeUndefined();
    expect(triggerAt("/rev notes", true)).toBeUndefined();
    expect(triggerAt("/", true)).not.toBeUndefined();
  });

  it("keeps the @ and $ tags as they were", () => {
    expect(triggerAt("@src", false)).toEqual({ char: "@", query: "src", start: 0 });
    expect(triggerAt("see $skill", false)).toEqual({ char: "$", query: "skill", start: 4 });
  });
});

describe("visiblePrompts", () => {
  it("answers the global prompts and the folder's own, in order", () => {
    expect(visiblePrompts(all, "C:/code/app")).toEqual([global, project]);
    expect(visiblePrompts(all, undefined)).toEqual([global]);
    expect(visiblePrompts(all, "C:/code/elsewhere")).toEqual([global]);
  });
});

describe("matchPrompts", () => {
  it("lists every visible prompt with nothing typed", () => {
    expect(matchPrompts([global, project], "")).toEqual([global, project]);
  });

  it("names those starting with the query before those containing it", () => {
    const review = prompt("r", "Summarise for review");
    expect(matchPrompts([review, global, project], "rev")).toEqual([project, review]);
    expect(matchPrompts([global, project], "zzz")).toEqual([]);
  });
});

describe("promptName", () => {
  it("names a message by its first line, cut short", () => {
    expect(promptName("  Summarise the changes\nSecond line")).toBe("Summarise the changes");
    expect(promptName(`A very long line ${"x".repeat(100)}`)).toBe(`A very long line ${"x".repeat(43)}…`);
  });
});

describe("withPrompt, withoutPrompt and movePrompt", () => {
  it("adds a new prompt at the end and keeps an edited one where it was", () => {
    const added = withPrompt([global], project);
    expect(added).toEqual([global, project]);
    const renamed = { ...project, name: "Renamed" };
    expect(withPrompt(added, renamed)).toEqual([global, renamed]);
  });

  it("drops a prompt by id", () => {
    expect(withoutPrompt([global, project], "g")).toEqual([project]);
    expect(withoutPrompt([global], "missing")).toEqual([global]);
  });

  it("steps a prompt toward either end and holds it there", () => {
    expect(movePrompt(all, "p", "up")).toEqual([project, global, other]);
    expect(movePrompt(all, "g", "up")).toEqual(all);
    expect(movePrompt(movePrompt(all, "g", "down"), "g", "down")).toEqual([project, other, global]);
    expect(movePrompt(all, "o", "down")).toEqual(all);
    expect(movePrompt(all, "missing", "up")).toEqual(all);
  });
});
