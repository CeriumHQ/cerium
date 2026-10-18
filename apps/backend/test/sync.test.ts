import {
  MAX_SYNC_BATCH_BYTES,
  type AccountThreads,
  type AgentEvent,
  type AgentId,
  type DeviceId,
  type EventId,
  type ThreadId,
  type ThreadOverview,
  type UiEvent,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { applyNotice, batches, cloudEvent } from "../src/sync.ts";

const event = (sequence: number, text = "done"): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: "thr_1" as ThreadId,
  agentId: "agt_1" as AgentId,
  sequence,
  at: sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
  raw: { provider: "secret" },
});

const overview = (id: string, title = id): ThreadOverview => ({
  thread: { id: id as ThreadId, title, mode: "work", createdAt: 1, updatedAt: 1 },
  agents: [],
  awaitingApproval: false,
});

describe("an event's cloud copy", () => {
  it("is the event as the UI sees it, without the provider's raw message", () => {
    const copy = cloudEvent(event(1));
    expect("raw" in copy).toBe(false);
    expect(copy.payload).toEqual({ _tag: "MessageCompleted", messageId: "m1", text: "done" });
  });

  it("cuts very long strings when the event is too big to store", () => {
    const copy = cloudEvent(event(2, "x".repeat(MAX_SYNC_BATCH_BYTES + 10)));
    const text = (copy.payload as { text: string }).text;
    expect(text.length).toBeLessThan(60_000);
    expect(text.endsWith("(shortened in the cloud copy)")).toBe(true);
  });
});

describe("batches", () => {
  it("keep each batch under the size the relay stores, in order", () => {
    const big = (sequence: number) => cloudEvent(event(sequence, "y".repeat(400_000)));
    const split = batches([big(1), big(2), big(3)]);
    expect(split.map((batch) => batch.map((each: UiEvent) => each.sequence))).toEqual([[1, 2], [3]]);
    for (const batch of split) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
  });

  it("make none of nothing", () => {
    expect(batches([])).toEqual([]);
  });
});

describe("the account's threads", () => {
  const desk = "desk" as DeviceId;
  const laptop = "laptop" as DeviceId;
  const start: AccountThreads = {
    threads: [
      { machine: desk, overview: overview("a") },
      { machine: laptop, overview: overview("b") },
    ],
    read: [{ threadId: "a" as ThreadId, seenAt: 5 }],
  };

  it("take a snapshot whole", () => {
    expect(applyNotice({ threads: [], read: [] }, { _tag: "AccountThreads", ...start })).toEqual(start);
  });

  it("replace changed threads and drop removed ones", () => {
    const next = applyNotice(start, {
      _tag: "ThreadsChanged",
      threads: [{ machine: desk, overview: overview("a", "Renamed") }],
      removed: [{ machine: laptop, threadId: "b" as ThreadId }],
    });
    expect(next.threads.map((each) => [each.machine, each.overview.thread.title])).toEqual([
      ["desk", "Renamed"],
    ]);
  });

  it("keep the latest time each thread was seen", () => {
    const next = applyNotice(start, {
      _tag: "ReadChanged",
      entries: [
        { threadId: "a" as ThreadId, seenAt: 3 },
        { threadId: "b" as ThreadId, seenAt: 9 },
      ],
    });
    expect(next.read).toEqual([
      { threadId: "a", seenAt: 5 },
      { threadId: "b", seenAt: 9 },
    ]);
  });
});
