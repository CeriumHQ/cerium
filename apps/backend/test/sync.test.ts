import {
  MAX_SYNC_BATCH_BYTES,
  type AgentEvent,
  type AgentId,
  type EventId,
  type ThreadId,
  type ThreadOverview,
  type UiEvent,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { batches, cloudEvent, lastActive } from "../src/sync.ts";

const event = (sequence: number, text = "done"): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: "thr_1" as ThreadId,
  agentId: "agt_1" as AgentId,
  sequence,
  at: sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
  raw: { provider: "secret" },
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

describe("lastActive", () => {
  it("is when the thread or the last of its agents changed", () => {
    const overview = (thread: number, agents: ReadonlyArray<number>) =>
      ({
        thread: { updatedAt: thread },
        agents: agents.map((updatedAt) => ({ updatedAt })),
        awaitingApproval: false,
      }) as unknown as ThreadOverview;
    expect(lastActive(overview(5, []))).toBe(5);
    expect(lastActive(overview(5, [3, 9, 7]))).toBe(9);
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
