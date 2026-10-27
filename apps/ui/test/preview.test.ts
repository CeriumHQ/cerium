import { describe, expect, it } from "@effect/vitest";

import { withoutBrowserTabs, type Session } from "../src/app/session.ts";
import { leavesOf, singlePane, splitPane } from "../src/features/split/model.ts";
import { DOCK, dockLayout } from "../src/features/preview/model.ts";

describe("dockLayout", () => {
  it("gives the preview its share of the pane", () => {
    expect(dockLayout(1200, 0.5)).toEqual({ covers: false, width: 600, min: DOCK.min, max: 800 });
  });

  it("never takes less than its least, nor what the conversation keeps", () => {
    expect(dockLayout(1200, 0.1).width).toBe(DOCK.min);
    expect(dockLayout(1200, 0.95).width).toBe(1200 - DOCK.beside);
  });

  it("covers the conversation in a pane too narrow for both", () => {
    expect(dockLayout(DOCK.min + DOCK.beside - 1, 0.5)).toMatchObject({ covers: true, width: 719 });
    expect(dockLayout(DOCK.min + DOCK.beside, 0.5).covers).toBe(false);
  });
});

describe("withoutBrowserTabs", () => {
  const session = (change: Partial<Session> = {}): Session => ({
    mode: "work",
    open: { work: "preview:thr_a" },
    blank: { work: "new:1", chat: "new:2" },
    pane: "main",
    ...change,
  });

  it("shows the thread whose browser a mode showed", () => {
    expect(withoutBrowserTabs(session()).open).toEqual({ work: "thr_a" });
  });

  it("drops the browser tabs from every machine's strips, closed ones included", () => {
    const restored = withoutBrowserTabs(
      session({
        tabs: {
          local: {
            work: {
              keys: ["thr_a", "preview:thr_a", "thr_b"],
              active: "preview:thr_a",
              closed: ["preview:thr_c", "thr_d"],
            },
          },
        },
      }),
    );
    expect(restored.tabs?.["local"]?.work).toEqual({
      keys: ["thr_a", "thr_b"],
      active: "thr_b",
      closed: ["thr_d"],
    });
  });

  it("closes the panes that showed a browser, and a split of one alone", () => {
    const split = splitPane(singlePane("1", "thr_a"), "1", "right", "preview:thr_a", "2");
    const restored = withoutBrowserTabs(
      session({ panes: { work: split, chat: singlePane("3", "preview:thr_b") } }),
    );
    expect(
      leavesOf(restored.panes?.work?.root ?? { kind: "pane", id: "", key: "" }).map((leaf) => leaf.key),
    ).toEqual(["thr_a"]);
    expect(restored.panes?.chat).toBeUndefined();
  });

  it("leaves a session without any as it was", () => {
    const plain = session({ open: { work: "thr_a" } });
    expect(withoutBrowserTabs(plain)).toEqual(plain);
  });
});
