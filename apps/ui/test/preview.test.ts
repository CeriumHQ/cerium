import { describe, expect, it } from "@effect/vitest";

import { restoredSession, withoutBrowserTabs, type Session } from "../src/app/session.ts";
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
    open: "preview:thr_a",
    blank: "new:1",
    pane: "main",
    ...change,
  });

  it("shows the thread whose browser a session showed", () => {
    expect(withoutBrowserTabs(session()).open).toBe("thr_a");
  });

  it("drops the browser tabs from every machine's strips, closed ones included", () => {
    const restored = withoutBrowserTabs(
      session({
        tabs: {
          local: {
            keys: ["thr_a", "preview:thr_a", "thr_b"],
            active: "preview:thr_a",
            closed: ["preview:thr_c", "thr_d"],
          },
        },
      }),
    );
    expect(restored.tabs?.["local"]).toEqual({
      keys: ["thr_a", "thr_b"],
      active: "thr_b",
      closed: ["thr_d"],
    });
  });

  it("closes the panes that showed a browser, and drops a single browser pane", () => {
    const split = splitPane(singlePane("1", "thr_a"), "1", "right", "preview:thr_a", "2");
    const restored = withoutBrowserTabs(session({ panes: split }));
    expect(
      leavesOf(restored.panes?.root ?? { kind: "pane", id: "", key: "" }).map((leaf) => leaf.key),
    ).toEqual(["thr_a"]);

    const soloBrowser = withoutBrowserTabs(session({ panes: singlePane("3", "preview:thr_b") }));
    expect(soloBrowser.panes).toBeUndefined();
  });

  it("migrates legacy per-mode sessions into one unified tab strip", () => {
    const storage = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      storage.set(
        "cerium:session",
        JSON.stringify({
          mode: "work",
          open: { work: "thr_work", chat: "thr_chat" },
          blank: { work: "new:1", chat: "new:2" },
          pane: "main",
          tabs: {
            local: {
              work: { keys: ["thr_work"], active: "thr_work", closed: ["thr_old"] },
              chat: { keys: ["thr_chat"], active: "thr_chat", closed: ["thr_old_chat"] },
            },
          },
        }),
      );
      const migrated = restoredSession();
      expect(migrated?.open).toBe("thr_work");
      expect(migrated?.tabs?.["local"]).toEqual({
        keys: ["thr_work", "thr_chat"],
        active: "thr_work",
        closed: ["thr_old", "thr_old_chat"],
      });
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
