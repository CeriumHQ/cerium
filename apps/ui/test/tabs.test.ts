import { describe, expect, it } from "@effect/vitest";

import {
  closeTabs,
  emptyStrip,
  keepTab,
  moveTab,
  othersOf,
  renameTab,
  reopenTab,
  rightOf,
  showTab,
  tabAtDigit,
  tabBeside,
  type TabStrip,
} from "../src/features/tabs/model.ts";

const strip = (keys: ReadonlyArray<string>, extra: Partial<TabStrip> = {}): TabStrip => ({
  keys,
  closed: [],
  ...extra,
});

describe("showTab", () => {
  it("opens the first tab", () => {
    expect(showTab(emptyStrip, "a", "preview")).toEqual(strip(["a"], { preview: "a", active: "a" }));
  });

  it("shows an open tab where it is", () => {
    expect(showTab(strip(["a", "b"], { active: "a" }), "b", "preview")).toEqual(
      strip(["a", "b"], { active: "b" }),
    );
  });

  it("keeps an open preview asked for in a tab of its own", () => {
    expect(showTab(strip(["a", "b"], { active: "a", preview: "b" }), "b", "tab")).toEqual(
      strip(["a", "b"], { active: "b" }),
    );
  });

  it("opens a new tab beside the active one", () => {
    expect(showTab(strip(["a", "b", "c"], { active: "a" }), "d", "tab").keys).toEqual(["a", "d", "b", "c"]);
  });

  it("replaces the previous preview with the next", () => {
    const shown = showTab(strip(["a", "p", "c"], { active: "c", preview: "p" }), "q", "preview");
    expect(shown).toEqual(strip(["a", "q", "c"], { active: "q", preview: "q" }));
  });

  it("puts a preview beside the active tab when there is none to replace", () => {
    expect(showTab(strip(["a", "b"], { active: "a" }), "q", "preview").keys).toEqual(["a", "q", "b"]);
  });

  it("replaces an active tab that can go without loss before the preview", () => {
    const shown = showTab(strip(["new", "p"], { active: "new", preview: "p" }), "q", "preview", (key) =>
      key.startsWith("new"),
    );
    expect(shown.keys).toEqual(["q", "p"]);
  });
});

describe("closeTabs", () => {
  it("shows the right neighbour of the active tab, else the left", () => {
    expect(closeTabs(strip(["a", "b", "c"], { active: "b" }), ["b"]).next).toBe("c");
    expect(closeTabs(strip(["a", "b", "c"], { active: "c" }), ["c"]).next).toBe("b");
  });

  it("leaves the active tab when another closes", () => {
    const { strip: left, next } = closeTabs(strip(["a", "b"], { active: "a" }), ["b"]);
    expect(next).toBe("a");
    expect(left).toEqual(strip(["a"], { active: "a", closed: ["b"] }));
  });

  it("says when no tab is left", () => {
    expect(closeTabs(strip(["a"], { active: "a", preview: "a" }), ["a"])).toEqual({
      strip: strip([], { closed: ["a"] }),
      next: undefined,
    });
  });

  it("closes the others or those to the right in one go", () => {
    const keys = ["a", "b", "c", "d"];
    expect(closeTabs(strip(keys, { active: "a" }), othersOf(keys, "c")).strip.keys).toEqual(["c"]);
    expect(closeTabs(strip(keys, { active: "d" }), rightOf(keys, "b"))).toMatchObject({
      strip: { keys: ["a", "b"], closed: ["c", "d"] },
      next: "b",
    });
  });

  it("forgets a tab whose thread is gone", () => {
    expect(closeTabs(strip(["a", "b"], { closed: ["b"] }), ["b"], { remember: false }).strip.closed).toEqual(
      [],
    );
  });
});

describe("reopenTab", () => {
  it("reopens the latest closed tab that can still open", () => {
    const { strip: left, key } = reopenTab(strip(["a"], { closed: ["b", "c", "d"] }), (each) => each !== "d");
    expect(key).toBe("c");
    expect(left.closed).toEqual(["b", "d"]);
  });

  it("has nothing to reopen once the list is spent", () => {
    expect(reopenTab(strip(["a"]), () => true).key).toBeUndefined();
  });
});

describe("renameTab", () => {
  it("turns a new thread's tab into the thread's, in place", () => {
    expect(renameTab(strip(["a", "new", "b"], { active: "new", preview: "new" }), "new", "t")).toEqual(
      strip(["a", "t", "b"], { active: "t", preview: "t" }),
    );
  });
});

describe("keepTab", () => {
  it("keeps the preview", () => {
    expect(keepTab(strip(["a"], { active: "a", preview: "a" }), "a")).toEqual(strip(["a"], { active: "a" }));
  });
});

describe("moveTab", () => {
  it("moves a tab to another place", () => {
    expect(moveTab(strip(["a", "b", "c"]), "a", 2).keys).toEqual(["b", "c", "a"]);
    expect(moveTab(strip(["a", "b", "c"]), "c", 0).keys).toEqual(["c", "a", "b"]);
    expect(moveTab(strip(["a", "b", "c"]), "b", 9).keys).toEqual(["a", "c", "b"]);
  });
});

describe("tab keys", () => {
  it("steps through the tabs, wrapping around", () => {
    expect(tabBeside(["a", "b", "c"], "c", 1)).toBe("a");
    expect(tabBeside(["a", "b", "c"], "a", -1)).toBe("c");
    expect(tabBeside([], "a", 1)).toBeUndefined();
  });

  it("goes to a tab by its place, 9 being the last", () => {
    const keys = ["a", "b", "c"];
    expect(tabAtDigit(keys, 2)).toBe("b");
    expect(tabAtDigit(keys, 9)).toBe("c");
    expect(tabAtDigit(keys, 5)).toBeUndefined();
  });
});
