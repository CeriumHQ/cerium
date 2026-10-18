import type { AccountThreads, DeviceId, ThreadId, ThreadOverview } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { applyNotice } from "../src/cloud.ts";

const overview = (id: string, title = id): ThreadOverview => ({
  thread: { id: id as ThreadId, title, mode: "work", createdAt: 1, updatedAt: 1 },
  agents: [],
  awaitingApproval: false,
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
