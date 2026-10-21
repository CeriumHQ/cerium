import { describe, expect, it } from "@effect/vitest";

import { githubKey } from "../src/features/github/model.ts";
import { isNonThreadKey } from "../src/features/tabs/tabKinds.ts";
import { commitFileKey, fileKey, turnFileKey, turnFileOfKey } from "../src/features/viewer/model.ts";

describe("non-thread tabs", () => {
  it("counts a file and a commit's file as tabs that aren't a thread's", () => {
    expect(isNonThreadKey(fileKey("C:\\Work\\app", "src/App.tsx"))).toBe(true);
    expect(isNonThreadKey(commitFileKey("C:\\Work\\app", "8be9dbc", "src/App.tsx", undefined))).toBe(true);
  });

  it("counts a file as an agent's turn changed it, and reads the tab back from its key", () => {
    const tab = { root: "C:\\Work\\app", before: "aaa", after: "bbb", path: "src/App.tsx" };
    expect(isNonThreadKey(turnFileKey(tab))).toBe(true);
    expect(turnFileOfKey(turnFileKey(tab))).toEqual(tab);
    expect(turnFileOfKey(fileKey("C:\\Work\\app", "src/App.tsx"))).toBeUndefined();
  });

  it("counts a pull request and an issue as tabs that aren't a thread's", () => {
    expect(isNonThreadKey(githubKey("C:\\Work\\app", "pr", 7))).toBe(true);
    expect(isNonThreadKey(githubKey("C:\\Work\\app", "issue", 42))).toBe(true);
  });

  it("leaves threads, drafts and nothing at all out of it", () => {
    expect(isNonThreadKey("thr_01a1563b")).toBe(false);
    expect(isNonThreadKey("new:1234")).toBe(false);
    expect(isNonThreadKey(undefined)).toBe(false);
  });
});
