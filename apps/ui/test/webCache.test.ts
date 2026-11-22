import type { AccountState, AccountThreads, DeviceId, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  cachedThreadsOf,
  decodeCached,
  encodeCached,
  newestThreads,
  THREADS_KEPT,
  type CachedThreads,
} from "../src/web/cache.ts";

const thread = (id: string, updatedAt: number) => ({
  machine: "desk" as DeviceId,
  overview: {
    thread: { id: id as ThreadId, title: id, mode: "work" as const, createdAt: 1, updatedAt },
    agents: [],
    awaitingApproval: false,
  },
});

const threads = (count: number): AccountThreads => ({
  threads: Array.from({ length: count }, (_, index) => thread(`thr_${index}`, index + 1)),
  read: Array.from({ length: count }, (_, index) => ({ threadId: `thr_${index}` as ThreadId, seenAt: 1 })),
});

const cached = (snapshot: AccountThreads): CachedThreads => ({
  account: "acct",
  savedAt: 5,
  threads: snapshot,
  devices: [{ id: "desk", name: "Desk" }],
});

const signedIn = (id: string): AccountState =>
  ({ _tag: "SignedIn", account: { id }, deviceId: "phone", connection: "connecting", devices: [] }) as never;

describe("the web client's kept threads", () => {
  it("come back as they were written", () => {
    const written = cached(threads(3));
    expect(decodeCached(encodeCached(written))).toEqual(written);
  });

  it("keep the most recently active threads, and what was seen of those", () => {
    const kept = newestThreads(threads(THREADS_KEPT + 5));
    expect(kept.threads).toHaveLength(THREADS_KEPT);
    expect(kept.threads[0]!.overview.thread.id).toBe(`thr_${THREADS_KEPT + 4}`);
    expect(kept.threads.some((each) => each.overview.thread.id === "thr_0")).toBe(false);
    expect(kept.read).toHaveLength(THREADS_KEPT);
  });

  it("read as none when missing or written another way", () => {
    expect(decodeCached(null)).toBeUndefined();
    expect(decodeCached("not json")).toBeUndefined();
    expect(decodeCached(JSON.stringify({ account: "acct" }))).toBeUndefined();
  });

  it("show only to the account they're of", () => {
    const kept = cached(threads(1));
    expect(cachedThreadsOf(kept, signedIn("acct"))).toBe(kept);
    expect(cachedThreadsOf(kept, signedIn("other"))).toBeUndefined();
    expect(cachedThreadsOf(kept, { _tag: "SignedOut" })).toBeUndefined();
  });
});
