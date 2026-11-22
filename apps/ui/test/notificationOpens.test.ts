import { describe, expect, it } from "@effect/vitest";

import type { ThreadSummary } from "../src/features/threads/model.ts";
import { OPEN_MESSAGE } from "../src/web/serviceWorker.ts";
import { badgeCount, tappedFromMessage } from "../src/web/push.ts";

const thread = (id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: 1,
  ...overrides,
});

describe("a tapped notification", () => {
  it("names its thread and the machine it's on", () => {
    expect(tappedFromMessage({ type: OPEN_MESSAGE, machine: "desk", threadId: "thr_1" })).toEqual({
      machine: "desk",
      threadId: "thr_1",
    });
    expect(tappedFromMessage({ type: OPEN_MESSAGE, threadId: "thr_1" })).toEqual({ threadId: "thr_1" });
  });

  it("is only the service worker's message about a thread", () => {
    expect(tappedFromMessage({ type: "other", threadId: "thr_1" })).toBeUndefined();
    expect(tappedFromMessage({ type: OPEN_MESSAGE })).toBeUndefined();
    expect(tappedFromMessage({ type: OPEN_MESSAGE, threadId: "" })).toBeUndefined();
    expect(tappedFromMessage(null)).toBeUndefined();
  });
});

describe("the app's badge", () => {
  it("counts the listed threads waiting on the user or unread", () => {
    expect(
      badgeCount([
        thread("idle"),
        thread("unread", { unread: true }),
        thread("asking", { status: "awaitingApproval" }),
        thread("failed", { status: "failed", unread: true }),
        thread("archived", { unread: true, archivedAt: 1 }),
        thread("archived-asking", { status: "awaitingApproval", archivedAt: 1 }),
      ]),
    ).toBe(4);
  });
});
