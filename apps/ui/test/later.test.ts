import { describe, expect, it } from "@effect/vitest";

import {
  archivedWork,
  backLabel,
  boxOf,
  customLaterTime,
  isPutOff,
  laterInHour,
  laterToday,
  laterTomorrow,
  laterNextWeek,
  laterTime,
  laterWork,
  overflow,
  type ThreadSummary,
} from "../src/features/threads/model.ts";
import { inboxSections } from "../src/features/threads/sections.ts";

const now = new Date(2026, 9, 21, 15, 0).getTime();
const HOUR = 3_600_000;
const thread = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  folder: "C:/code/cerium",
  project: "cerium",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - HOUR,
  ...patch,
});

describe("Later", () => {
  it("puts a thread off until tomorrow morning", () => {
    expect(laterTime(now)).toBe(new Date(2026, 9, 22, 8, 0).getTime());
    expect(laterTomorrow(new Date(2026, 11, 31, 23, 30).getTime())).toBe(new Date(2027, 0, 1, 8).getTime());
  });

  it("adds one elapsed hour, including across midnight", () => {
    const late = new Date(2026, 9, 21, 23, 45).getTime();
    expect(laterInHour(now)).toBe(new Date(2026, 9, 21, 16).getTime());
    expect(laterInHour(late)).toBe(new Date(2026, 9, 22, 0, 45).getTime());
  });

  it("uses 5 PM before 4 PM and two elapsed hours from 4 PM onward", () => {
    const today = (hour: number, minute = 0) => new Date(2026, 9, 21, hour, minute).getTime();
    expect(laterToday(today(8))).toBe(today(17));
    expect(laterToday(today(15, 59))).toBe(today(17));
    expect(laterToday(today(16))).toBe(today(18));
    expect(laterToday(today(20, 30))).toBe(today(22, 30));
    expect(laterToday(today(23, 15))).toBe(new Date(2026, 9, 22, 1, 15).getTime());
  });

  it("uses the upcoming Monday at 8 AM even on Sunday, and skips to the following week on Monday", () => {
    const sunday = new Date(2026, 9, 25, 23, 59).getTime();
    const monday = new Date(2026, 9, 26, 7).getTime();
    expect(laterNextWeek(now)).toBe(new Date(2026, 9, 26, 8).getTime());
    expect(laterNextWeek(sunday)).toBe(new Date(2026, 9, 26, 8).getTime());
    expect(laterNextWeek(monday)).toBe(new Date(2026, 10, 2, 8).getTime());
  });

  it("accepts future local times and rejects empty, malformed, adjusted, and past values", () => {
    expect(customLaterTime("2026-10-21T15:01", now)).toBe(new Date(2026, 9, 21, 15, 1).getTime());
    for (const value of [
      "",
      "2026-10-21",
      "2026-10-21T15:00",
      "2026-10-21T14:59",
      "2027-02-30T12:00",
      "2027-01-01T24:00",
      "2027-01-01T12:00Z",
    ]) {
      expect(customLaterTime(value, now)).toBeUndefined();
    }
  });

  it("keeps a thread off until it's due, unless it needs the user sooner", () => {
    const off = thread("a", { laterUntil: now + HOUR });
    expect(isPutOff(off, now)).toBe(true);
    expect(isPutOff(off, now + 2 * HOUR)).toBe(false);
    expect(isPutOff({ ...off, status: "awaitingApproval" }, now)).toBe(false);
    expect(isPutOff({ ...off, status: "failed", unread: true }, now)).toBe(false);
    expect(isPutOff({ ...off, archivedAt: now }, now)).toBe(false);
  });

  it("lists what's put off, the soonest back first", () => {
    const threads = [
      thread("late", { laterUntil: now + 3 * HOUR }),
      thread("here"),
      thread("soon", { laterUntil: now + HOUR }),
    ];
    expect(laterWork(threads, now).map(({ id }) => id)).toEqual(["soon", "late"]);
  });

  it("brings a thread back to the top of its group from when it returns", () => {
    const back = thread("back", { updatedAt: now - 30 * HOUR, laterUntil: now - 5 * 60_000 });
    const sections = inboxSections([thread("recent"), back], now);
    expect(sections[0]?.threads.map(({ id }) => id)).toEqual(["back", "recent"]);
  });

  it("says when a thread comes back", () => {
    expect(backLabel(new Date(2026, 9, 22, 8, 0).getTime(), now)).toBe("Tomorrow");
    expect(backLabel(new Date(2026, 9, 24, 8, 0).getTime(), now)).toBe("Sat");
    expect(backLabel(new Date(2026, 10, 3, 8, 0).getTime(), now)).toBe("3 Nov");
  });
});

describe("boxOf", () => {
  it("finds the list a thread is in", () => {
    expect(boxOf(thread("a"), now)).toBe("inbox");
    expect(boxOf(undefined, now)).toBe("inbox");
    expect(boxOf(thread("a", { laterUntil: now + HOUR }), now)).toBe("later");
    expect(boxOf(thread("a", { archivedAt: now }), now)).toBe("archive");
    // A request is never out of sight, archived or not.
    expect(boxOf(thread("a", { archivedAt: now, status: "awaitingApproval" }), now)).toBe("inbox");
  });

  it("lists the most recently archived first", () => {
    const threads = [thread("old", { archivedAt: now - HOUR }), thread("new", { archivedAt: now })];
    expect(archivedWork(threads).map(({ id }) => id)).toEqual(["new", "old"]);
  });
});

describe("the inbox's cap", () => {
  const quiet = (id: string, hoursAgo: number) => thread(id, { updatedAt: now - hoursAgo * HOUR });

  it("lets nothing go while the inbox fits", () => {
    expect(overflow([quiet("a", 1), quiet("b", 2)], () => false, now, 2)).toEqual([]);
  });

  it("archives the oldest quiet threads beyond the cap", () => {
    const inbox = [quiet("a", 1), quiet("b", 5), quiet("c", 3), quiet("d", 2)];
    expect(overflow(inbox, () => false, now, 2).map(({ id }) => id)).toEqual(["b", "c"]);
  });

  it("uses the configured cap and keeps everything when auto-archive is off", () => {
    const inbox = Array.from({ length: 16 }, (_, index) => quiet(String(index), index + 1));
    expect(overflow(inbox, () => false, now, 12).map(({ id }) => id)).toEqual(["15", "14", "13", "12"]);
    expect(overflow(inbox, () => false, now, 20)).toEqual([]);
    expect(overflow(inbox, () => false, now, 0)).toEqual([]);
    expect(overflow(inbox, () => false, now, -1)).toEqual([]);
  });

  it("leaves alone what's live, unread, kept, in a worktree or on another machine", () => {
    const inbox = [
      thread("running", { status: "running", updatedAt: 1 }),
      thread("unread", { unread: true, updatedAt: 1 }),
      thread("pinned", { updatedAt: 1 }),
      thread("worktree", { worktree: { branch: "feat/x", base: "main" }, updatedAt: 1 }),
      thread("elsewhere", { elsewhere: { machine: "m1", online: true }, updatedAt: 1 }),
      quiet("old", 9),
      quiet("new", 1),
    ];
    const gone = overflow(inbox, ({ id }) => id === "pinned", now, 1);
    expect(gone.map(({ id }) => id)).toEqual(["old", "new"]);
  });
});
