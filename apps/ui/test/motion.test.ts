import { describe, expect, it } from "@effect/vitest";

import { lingerIn, type Lingering } from "../src/lib/motion.ts";

const keyOf = (item: string) => item;
const shown = (entries: ReadonlyArray<Lingering<string>>) =>
  entries.map((entry) => (entry.present ? entry.key : `(${entry.key})`)).join(" ");

describe("lingerIn", () => {
  it("shows a new list as it is", () => {
    expect(shown(lingerIn([], ["a", "b"], keyOf))).toBe("a b");
  });

  it("keeps an item that left where it stood, after the one it followed", () => {
    const before = lingerIn([], ["a", "b", "c"], keyOf);
    expect(shown(lingerIn(before, ["a", "c"], keyOf))).toBe("a (b) c");
  });

  it("keeps a first item that left at the start", () => {
    const before = lingerIn([], ["a", "b"], keyOf);
    expect(shown(lingerIn(before, ["b"], keyOf))).toBe("(a) b");
  });

  it("keeps items that left one after another in their order", () => {
    const before = lingerIn([], ["a", "b", "c", "d"], keyOf);
    const once = lingerIn(before, ["a", "c", "d"], keyOf);
    expect(shown(lingerIn(once, ["a", "d"], keyOf))).toBe("a (b) (c) d");
  });

  it("shows an item that comes back as present again", () => {
    const before = lingerIn(lingerIn([], ["a", "b"], keyOf), ["a"], keyOf);
    expect(shown(lingerIn(before, ["a", "b"], keyOf))).toBe("a b");
  });

  it("places new items where the list puts them", () => {
    const before = lingerIn(lingerIn([], ["a", "b"], keyOf), ["b"], keyOf);
    expect(shown(lingerIn(before, ["c", "b"], keyOf))).toBe("(a) c b");
  });
});
