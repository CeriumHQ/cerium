import type { AccountThreads, DeviceId, ThreadId, ThreadOverview } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { applyDraftNotice, applyNotice } from "../src/cloud.ts";

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

describe("the account's drafts", () => {
  it("are ready once the relay sent them, keeping each key's latest edit", () => {
    const sent = applyDraftNotice(
      { ready: false, drafts: [{ key: "a", updatedAt: 9, draft: "mine" }] },
      {
        _tag: "AccountDrafts",
        drafts: [
          { key: "a", updatedAt: 4, draft: "old" },
          { key: "b", updatedAt: 2 },
        ],
      },
    );
    expect(sent).toEqual({
      ready: true,
      drafts: [
        { key: "a", updatedAt: 9, draft: "mine" },
        { key: "b", updatedAt: 2 },
      ],
    });
  });

  it("take newer changes, and wait for the relay again once the connection drops", () => {
    const changed = applyDraftNotice(
      { ready: true, drafts: [{ key: "a", updatedAt: 1, draft: "old" }] },
      { _tag: "DraftsChanged", drafts: [{ key: "a", updatedAt: 3 }] },
    );
    expect(changed).toEqual({ ready: true, drafts: [{ key: "a", updatedAt: 3 }] });
    expect(applyDraftNotice(changed, { _tag: "RelayLost" }).ready).toBe(false);
  });
});
