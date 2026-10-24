import {
  RelayMessage,
  type AgentId,
  type DeviceId,
  type DraftEntry,
  type ThreadId,
  type ThreadOverview,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { accountDraftsJson, accountThreadsJson, appendBatch } from "../src/sync.ts";

describe("appending a batch to the cloud copy", () => {
  it("keeps a batch that follows on from what the cloud has", () => {
    expect(appendBatch(3, 3, ["d", "e"])).toEqual({ keep: ["d", "e"], count: 5 });
    expect(appendBatch(0, 0, ["a"])).toEqual({ keep: ["a"], count: 1 });
  });

  it("trims what the cloud already has from a batch sent again", () => {
    expect(appendBatch(5, 3, ["d", "e", "f"])).toEqual({ keep: ["f"], count: 6 });
    expect(appendBatch(5, 3, ["d", "e"])).toEqual({ keep: [], count: 5 });
  });

  it("keeps nothing from a batch past a gap, so the machine resends from what the cloud has", () => {
    expect(appendBatch(2, 4, ["e", "f"])).toEqual({ keep: [], count: 2 });
  });
});

describe("what a device is sent on connecting", () => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RelayMessage));
  const overview = (id: string, title: string): ThreadOverview => ({
    thread: {
      id: id as ThreadId,
      title,
      mode: "work",
      cwd: "C:\\Users\\me\\repo",
      createdAt: 1,
      updatedAt: 2,
    },
    agents: [
      {
        id: `${id}-lead` as AgentId,
        threadId: id as ThreadId,
        role: "lead",
        provider: "claude",
        model: "opus",
        access: "ask",
        state: "idle",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    awaitingApproval: true,
  });
  // Stored as the relay stores them: the JSON of what it decoded.
  const threads = [
    { machine: "desk", overview: JSON.stringify(overview("a", 'Quotes " and \\ and </script>')) },
    { machine: "laptop", overview: JSON.stringify(overview("b", "Ünïcødé \u2028 \ud83d\ude80 \ud800")) },
  ];
  const read = [{ threadId: "a" as ThreadId, seenAt: 5 }];
  const drafts = [
    { key: "a", updatedAt: 7, draft: JSON.stringify({ text: 'Hi "there"\n', images: [1, 2.5, null] }) },
    { key: "new:1", updatedAt: 8, draft: null },
  ];

  it("sends the stored overviews as the very bytes parsing and stringifying each would", () => {
    const message = {
      _tag: "AccountThreads",
      threads: threads.map((row) => ({
        machine: row.machine as DeviceId,
        overview: JSON.parse(row.overview) as ThreadOverview,
      })),
      read,
    } satisfies RelayMessage;
    expect(accountThreadsJson(threads, read)).toBe(JSON.stringify(message));
    expect(decode(accountThreadsJson(threads, read))).toEqual(message);
    expect(accountThreadsJson([], [])).toBe(
      JSON.stringify({ _tag: "AccountThreads", threads: [], read: [] }),
    );
  });

  it("sends the stored drafts likewise, leaving out the content of gone ones", () => {
    const message = {
      _tag: "AccountDrafts",
      drafts: drafts.map((row): DraftEntry => ({
        key: row.key,
        updatedAt: row.updatedAt,
        ...(row.draft === null
          ? {}
          : { draft: JSON.parse(row.draft) as Exclude<DraftEntry["draft"], undefined> }),
      })),
    } satisfies RelayMessage;
    expect(accountDraftsJson(drafts)).toBe(JSON.stringify(message));
    expect(decode(accountDraftsJson(drafts))).toEqual(message);
    expect(accountDraftsJson([])).toBe(JSON.stringify({ _tag: "AccountDrafts", drafts: [] }));
  });
});
