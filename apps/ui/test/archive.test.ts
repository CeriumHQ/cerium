import { describe, expect, it } from "@effect/vitest";

import { whenArchived } from "../src/features/settings/Archived.tsx";
import {
  archivedThreads,
  canArchive,
  isListed,
  renamedTitle,
  type ThreadSummary,
} from "../src/features/threads/model.ts";

const now = new Date(2026, 9, 18, 15, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const thread = (id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - HOUR,
  ...overrides,
});

describe("archiving", () => {
  it("hides archived threads, except while they wait on the user", () => {
    expect(isListed(thread("open"))).toBe(true);
    expect(isListed(thread("archived", { archivedAt: now }))).toBe(false);
    expect(isListed(thread("asking", { archivedAt: now, status: "awaitingApproval" }))).toBe(true);
  });

  it("only archives threads whose agents aren't working or waiting on the user", () => {
    expect(canArchive(thread("idle"))).toBe(true);
    expect(canArchive(thread("failed", { status: "failed" }))).toBe(true);
    expect(canArchive(thread("running", { status: "running" }))).toBe(false);
    expect(canArchive(thread("asking", { status: "awaitingApproval" }))).toBe(false);
  });

  it("lists archived threads, the most recently archived first", () => {
    const listed = archivedThreads([
      thread("first", { archivedAt: now - HOUR }),
      thread("kept"),
      thread("last", { archivedAt: now }),
    ]);
    expect(listed.map(({ id }) => id)).toEqual(["last", "first"]);
  });

  it("says when a thread was archived the way people say it", () => {
    expect(whenArchived(now - 20_000, now)).toBe("just now");
    expect(whenArchived(now - 5 * MINUTE, now)).toBe("5 minutes ago");
    expect(whenArchived(now - 3 * HOUR, now)).toBe("3 hours ago");
    expect(whenArchived(now - 20 * HOUR, now)).toBe("yesterday");
    expect(whenArchived(new Date(2026, 9, 2).getTime(), now)).toBe("on 2 Oct");
    expect(whenArchived(new Date(2025, 11, 24).getTime(), now)).toBe("on 24 Dec 2025");
  });
});

describe("renamedTitle", () => {
  it("trims the typed title and cuts it to 80 characters", () => {
    expect(renamedTitle("Old", "  New title  ")).toBe("New title");
    expect(renamedTitle("Old", "x".repeat(90))).toBe("x".repeat(80));
  });

  it("saves nothing for an empty or unchanged title", () => {
    expect(renamedTitle("Old", "   ")).toBeUndefined();
    expect(renamedTitle("Old", " Old ")).toBeUndefined();
  });
});
