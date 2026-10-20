import { describe, expect, it } from "@effect/vitest";

import { togglePin, withPinned } from "../src/features/threads/pins.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";
import { chatSections } from "../src/features/threads/sections.ts";

const now = new Date(2026, 9, 18, 15, 0).getTime();
const thread = (id: string, updatedAt: number): ThreadSummary => ({
  id,
  title: id,
  mode: "chat",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt,
});

describe("pins", () => {
  it("toggles a pin, newest pin first", () => {
    expect(togglePin(["a"], "b")).toEqual(["b", "a"]);
    expect(togglePin(["b", "a"], "b")).toEqual(["a"]);
  });

  it("lists pinned threads in their own group first, in pinned order, and drops emptied groups", () => {
    const sections = chatSections(
      [thread("a", now), thread("b", now - 1), thread("c", now - 9 * 86_400_000)],
      now,
    );
    const pinned = withPinned(sections, ["c", "a", "gone"]);
    expect(pinned.map(({ label, threads }) => [label, threads.map(({ id }) => id)])).toEqual([
      ["Pinned", ["c", "a"]],
      ["Today", ["b"]],
    ]);
  });

  it("leaves the sections alone with nothing pinned", () => {
    const sections = chatSections([thread("a", now)], now);
    expect(withPinned(sections, [])).toBe(sections);
  });
});
