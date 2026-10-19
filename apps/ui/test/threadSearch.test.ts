import { describe, expect, it } from "@effect/vitest";

import type { ThreadSummary } from "../src/features/threads/model.ts";
import { highlight, queryWords, searchResults } from "../src/features/threads/threadSearch.ts";

const now = new Date(2026, 9, 18, 15, 0).getTime();
const HOUR = 3_600_000;

const thread = (id: string, title: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title,
  mode: "work",
  project: "cerium",
  folder: "C:/code/cerium",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - HOUR,
  ...overrides,
});

const ids = (results: ReturnType<typeof searchResults>) => results.map(({ thread: { id } }) => id);

describe("queryWords", () => {
  it("splits on spaces and ignores case and accents", () => {
    expect(queryWords("  Café   MENU ")).toEqual(["cafe", "menu"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("highlight", () => {
  it("marks each word where it starts a word, merging overlaps", () => {
    expect(highlight("Fix the flaky checkout test", ["checkout", "fl"])).toEqual([
      { text: "Fix the ", match: false },
      { text: "fl", match: true },
      { text: "aky ", match: false },
      { text: "checkout", match: true },
      { text: " test", match: false },
    ]);
    expect(highlight("flaky", ["fla", "flak"])).toEqual([
      { text: "flak", match: true },
      { text: "y", match: false },
    ]);
  });

  it("leaves the middle of a word alone", () => {
    expect(highlight("I've just updated Cerium", ["dat"])).toEqual([
      { text: "I've just updated Cerium", match: false },
    ]);
    expect(highlight("The data layer", ["dat"])).toEqual([
      { text: "The ", match: false },
      { text: "dat", match: true },
      { text: "a layer", match: false },
    ]);
  });

  it("finds accented text from plain words and keeps the original spelling", () => {
    expect(highlight("Café menu", ["cafe"])).toEqual([
      { text: "Café", match: true },
      { text: " menu", match: false },
    ]);
  });

  it("returns the text whole when nothing matches", () => {
    expect(highlight("Nothing here", ["zzz"])).toEqual([{ text: "Nothing here", match: false }]);
    expect(highlight("Nothing here", [])).toEqual([{ text: "Nothing here", match: false }]);
  });
});

describe("searchResults", () => {
  const threads = [
    thread("a", "Fix flaky checkout test", { updatedAt: now - 3 * HOUR }),
    thread("b", "Checkout page redesign", { updatedAt: now - 5 * HOUR }),
    thread("c", "Rename the settings tabs", { updatedAt: now - HOUR }),
    thread("d", "Slow checkout", { project: "shop", updatedAt: now - 2 * HOUR }),
    thread("e", "Old spike", { archivedAt: now, updatedAt: now - 9 * HOUR }),
  ];

  it("offers the latest threads, archived ones left out, before anything is typed", () => {
    expect(ids(searchResults(threads, ""))).toEqual(["c", "d", "a", "b"]);
    expect(ids(searchResults(threads, "   "))).toEqual(["c", "d", "a", "b"]);
  });

  it("filters by title, a title that starts with the word first, then newest first", () => {
    expect(ids(searchResults(threads, "checkout"))).toEqual(["b", "d", "a"]);
  });

  it("matches the starts of words, not the middle of them", () => {
    expect(ids(searchResults(threads, "heckout"))).toEqual([]);
    expect(ids(searchResults(threads, "check"))).toEqual(["b", "d", "a"]);
  });

  it("needs every word, in any order, and matches the project's name too", () => {
    expect(ids(searchResults(threads, "test checkout"))).toEqual(["a"]);
    expect(ids(searchResults(threads, "shop slow"))).toEqual(["d"]);
    expect(ids(searchResults(threads, "settings zzz"))).toEqual([]);
  });

  it("searches archived threads", () => {
    expect(ids(searchResults(threads, "spike"))).toEqual(["e"]);
  });

  it("adds threads found only in their messages after the titles, and keeps each passage", () => {
    const passage = [{ text: "the checkout flow", match: true }];
    const results = searchResults(threads, "checkout", [
      { threadId: "c", passage },
      { threadId: "a", passage },
      { threadId: "gone", passage },
    ]);
    expect(ids(results)).toEqual(["b", "d", "a", "c"]);
    expect(results.map((result) => result.passage !== undefined)).toEqual([false, false, true, true]);
  });
});
