import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { BrowserWindow } from "electron";

type Handler = (event: { sender: unknown }, ...args: Array<unknown>) => unknown;
const fake = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
  run: (): Promise<{ text: string }> => Promise.resolve({ text: "done" }),
  closed: [] as string[],
}));

vi.mock("electron", () => {
  const partition = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    setSpellCheckerEnabled() {},
  };
  class Contents {
    url = "";
    destroyed = false;
    attached = false;
    entries: Array<{ url: string; title: string }> = [];
    debugger = {
      on() {},
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
      },
      detach: () => {
        this.attached = false;
      },
    };
    navigationHistory = {
      canGoBack: () => this.entries.length > 1,
      canGoForward: () => false,
      getActiveIndex: () => this.entries.length - 1,
      getAllEntries: () => this.entries,
      restore: async ({
        entries,
        index,
      }: {
        entries: Array<{ url: string; title: string }>;
        index: number;
      }) => {
        this.entries = entries;
        this.url = entries[index]!.url;
      },
    };
    isDestroyed() {
      return this.destroyed;
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return "Page";
    }
    isLoading() {
      return false;
    }
    setBackgroundThrottling() {}
    setWindowOpenHandler() {}
    on() {}
    async loadURL(url: string) {
      this.url = url;
      this.entries.push({ url, title: "Page" });
    }
    close() {
      this.destroyed = true;
      fake.closed.push(this.url);
    }
  }
  class BaseWindow {
    contentView = { addChildView() {}, removeChildView() {} };
    isDestroyed() {
      return false;
    }
    getContentBounds() {
      return { width: 1280, height: 800 };
    }
    setContentBounds() {}
    isVisible() {
      return true;
    }
    showInactive() {}
    destroy() {}
  }
  return {
    BaseWindow,
    session: { fromPartition: () => partition },
    ipcMain: {
      handle: (name: string, handler: Handler) => fake.handlers.set(name, handler),
      on: (name: string, handler: Handler) => fake.listeners.set(name, handler),
    },
    WebContentsView: class {
      webContents = new Contents();
      setBackgroundColor() {}
      setBorderRadius() {}
      setVisible() {}
      setBounds() {}
    },
  };
});
vi.mock("@cerium/browser", async (original) => {
  const browser = await original<typeof import("@cerium/browser")>();
  return {
    ...browser,
    Page: { attach: async () => ({ cdp: { send: async () => ({}) } }) },
    runCommand: () => fake.run(),
  };
});

import { previews } from "../src/preview.ts";

const setup = () => {
  vi.useFakeTimers();
  fake.closed = [];
  fake.run = () => Promise.resolve({ text: "done" });
  const contents = { send() {}, getZoomFactor: () => 1 };
  const owner = {
    webContents: contents,
    isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} },
  } as unknown as BrowserWindow;
  const pages = previews(() => owner);
  const fire = (name: string, ...args: Array<unknown>) =>
    fake.listeners.get(`cerium:preview-${name}`)!({ sender: contents }, ...args);
  const call = (name: string, ...args: Array<unknown>) =>
    fake.handlers.get(`cerium:preview-${name}`)!({ sender: contents }, ...args);
  const states = () => call("states") as Array<{ threadId: string; url: string; canGoBack: boolean }>;
  return { pages, fire, call, states };
};
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("preview page lifetime", () => {
  it("closes excess hidden pages while keeping the running agent's oldest page", async () => {
    const { pages, fire, call, states } = setup();
    for (let i = 0; i < 8; i++) await call("navigate", `thr_${i}`, `http://localhost/page/${i}`);
    expect(states()).toHaveLength(8);
    fire(
      "threads",
      Array.from({ length: 8 }, (_, i) => ({ id: `thr_${i}`, active: i === 0, retired: false })),
    );
    expect(states()).toHaveLength(5);
    expect(states().some((state) => state.threadId === "thr_0")).toBe(true);
    expect(fake.closed).toHaveLength(3);
    pages.closeAll();
  });

  it("waits for an in-flight call before closing a newly archived page", async () => {
    const { pages, fire, call, states } = setup();
    fire("threads", [{ id: "thr_active", active: true, retired: false }]);
    await call("navigate", "thr_active", "http://localhost/active");
    let finish!: (value: { text: string }) => void;
    fake.run = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = call("run", "thr_active", { _tag: "Read" });
    // Attaching the debugger and page takes a few promise continuations.
    for (let i = 0; i < 10 && finish === undefined; i++) await Promise.resolve();
    fire("retire", "thr_active");
    expect(states()).toHaveLength(1);
    finish({ text: "done" });
    await pending;
    expect(states()).toHaveLength(0);
    expect(fake.closed).toEqual(["http://localhost/active"]);
    pages.closeAll();
  });

  it("restores an evicted page's navigation and permits reopening an archived page", async () => {
    const { pages, fire, call, states } = setup();
    fire("threads", [{ id: "thr_old", active: false, retired: false }]);
    await call("navigate", "thr_old", "http://localhost/first");
    await call("navigate", "thr_old", "http://localhost/second");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(states()).toHaveLength(0);
    fire("place", "thr_old", { x: 0, y: 0, width: 640, height: 480 });
    expect(states()[0]).toMatchObject({ url: "http://localhost/second", canGoBack: true });
    fire("threads", [{ id: "thr_old", active: false, retired: true }]);
    expect(states()).toHaveLength(0);
    fire("place", "thr_old", { x: 0, y: 0, width: 640, height: 480 });
    fire("threads", [{ id: "thr_old", active: false, retired: true }]);
    expect(states()).toHaveLength(1);
    pages.closeAll();
  });

  it("lets only the current page's calls release it after an explicit close and reopen", async () => {
    const { pages, fire, call, states } = setup();
    fire("threads", [{ id: "thr_reopened", active: true, retired: false }]);
    const finishes: Array<(value: { text: string }) => void> = [];
    fake.run = () => new Promise((resolve) => finishes.push(resolve));
    await call("navigate", "thr_reopened", "http://localhost/old");
    const oldCall = call("run", "thr_reopened", { _tag: "Read" });
    for (let i = 0; i < 10 && finishes.length < 1; i++) await Promise.resolve();
    fire("close", "thr_reopened");
    await call("navigate", "thr_reopened", "http://localhost/new");
    const newCall = call("run", "thr_reopened", { _tag: "Read" });
    for (let i = 0; i < 10 && finishes.length < 2; i++) await Promise.resolve();
    fire("retire", "thr_reopened");
    finishes[0]!({ text: "old completed" });
    await oldCall;
    expect(states()).toHaveLength(1);
    expect(states()[0]!.url).toBe("http://localhost/new");
    finishes[1]!({ text: "new completed" });
    await newCall;
    expect(states()).toHaveLength(0);
    pages.closeAll();
  });
});
