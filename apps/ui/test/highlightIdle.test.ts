import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { WORKER_IDLE_MS } from "../src/features/viewer/highlight.ts";

/** A worker that answers every range with plain text and records being created and terminated. */
class FakeWorker extends EventTarget {
  static made: Array<FakeWorker> = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.made.push(this);
  }
  postMessage(request: { type: string; id: number }) {
    if (request.type === "range")
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: { id: request.id, lines: [[["x"]]] } })),
      );
  }
  terminate() {
    this.terminated = true;
  }
}

describe("highlight worker lifetime", () => {
  let subscribeHighlight: typeof import("../src/features/viewer/highlight.ts").subscribeHighlight;
  beforeEach(async () => {
    FakeWorker.made = [];
    // The highlighter keeps its worker in module state: each test starts from a fresh module.
    vi.resetModules();
    ({ subscribeHighlight } = await import("../src/features/viewer/highlight.ts"));
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is dropped after it sat idle, and started again by the next range", async () => {
    const leave = subscribeHighlight({ text: "x", path: "a.ts" }, 0, 1, () => {});
    await vi.advanceTimersByTimeAsync(0);
    leave();
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS - 1);
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    const again = subscribeHighlight({ text: "y", path: "b.ts" }, 0, 1, () => {});
    expect(FakeWorker.made).toHaveLength(2);
    again();
  });

  it("stays while a range is on screen, however long", async () => {
    const leave = subscribeHighlight({ text: "x", path: "a.ts" }, 0, 1, () => {});
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS * 4);
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    leave();
  });

  it("is kept when a range returns before the idle time is up", async () => {
    subscribeHighlight({ text: "x", path: "a.ts" }, 0, 1, () => {})();
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS - 1);
    const back = subscribeHighlight({ text: "z", path: "c.ts" }, 0, 1, () => {});
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS - 1);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    back();
  });
});
