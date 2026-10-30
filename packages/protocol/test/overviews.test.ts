import {
  applyOverviewUpdate,
  ThreadOverviewUpdate,
  type ThreadId,
  type ThreadOverview,
} from "../src/index.ts";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

const overview = (id: string, createdAt = 1): ThreadOverview => ({
  thread: { id: id as ThreadId, title: id, mode: "work", createdAt, updatedAt: 1 },
  agents: [],
  awaitingApproval: false,
});

describe("overview patches across versions", () => {
  it("removes an old row when its replacement uses a provider this client cannot read", () => {
    const current = [overview("old")];
    const update = Schema.decodeSync(ThreadOverviewUpdate)({
      _tag: "Patch",
      revision: 1,
      removed: ["old"],
      threads: [
        {
          ...current[0],
          agents: [
            {
              id: "agent",
              threadId: "old",
              role: "lead",
              provider: "future-provider",
              model: "future",
              access: "ask",
              state: "running",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
    });
    expect(update.threads).toEqual([]);
    expect(applyOverviewUpdate(current, update)).toEqual([]);
    expect(current).toHaveLength(1);
  });
  it("preserves unchanged row identities and replaces stale state on a reconnect reset", () => {
    const current = [overview("first"), overview("second", 2)];
    const archived = { ...current[0]!, thread: { ...current[0]!.thread, archivedAt: 10 } };
    const next = applyOverviewUpdate(current, {
      _tag: "Patch",
      revision: 50,
      removed: [current[0]!.thread.id],
      threads: [archived],
    });
    expect(next).toEqual([archived, current[1]]);
    expect(next[1]).toBe(current[1]);
    expect(current[0]!.thread.archivedAt).toBeUndefined();
    expect(applyOverviewUpdate(next, { _tag: "Reset", revision: 0, threads: [archived] })).toEqual([
      archived,
    ]);
  });
});
