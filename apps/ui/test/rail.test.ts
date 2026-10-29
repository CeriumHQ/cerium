import type { ProviderUsage } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { badgeLabel, badgeNote, railBadges, usageRings } from "../src/app/railModel.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";

const now = Date.UTC(2026, 9, 25, 12);

const claude: ProviderUsage = {
  _tag: "Subscribed",
  provider: "claude",
  plan: "max",
  meters: [
    { label: "Current session", usedPercent: 40 },
    { label: "Weekly", usedPercent: 70 },
    { label: "Extra usage", usedPercent: 95, spend: { used: 95, limit: 100, currency: "USD" } },
  ],
  checkedAt: now,
};

const codex: ProviderUsage = {
  _tag: "Subscribed",
  provider: "codex",
  meters: [{ label: "5-hour", usedPercent: 92 }],
  checkedAt: now,
};

describe("usageRings", () => {
  it("shows the limit with the least left, leaving a spending cap out", () => {
    const [ring] = usageRings([claude], new Set(["claude"]));
    expect(ring?.label).toBe("Weekly");
    expect(ring?.left).toBe(30);
    expect(ring?.plan).toBe("max");
    expect(ring?.meters).toHaveLength(3);
  });

  it("shows a harness's only limit", () => {
    expect(usageRings([codex], new Set(["codex"]))[0]?.left).toBe(8);
  });

  it("shows only harnesses that can run threads, and none that couldn't be read", () => {
    const unreadable: ProviderUsage = { _tag: "UsageUnreadable", provider: "codex", message: "Offline" };
    expect(usageRings([claude, unreadable], new Set(["codex"]))).toEqual([]);
  });

  it("counts a spending cap when it's the plan's only meter", () => {
    const capped: ProviderUsage = {
      _tag: "Subscribed",
      provider: "cursor",
      meters: [{ label: "Monthly", usedPercent: 25, spend: { used: 5, limit: 20, currency: "USD" } }],
      checkedAt: now,
    };
    expect(usageRings([capped], new Set(["cursor"]))[0]?.left).toBe(75);
  });
});

const thread = (id: string, fields: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - 1000,
  ...fields,
});

describe("railBadges", () => {
  it("counts the inbox's unread work threads and those waiting on the user", () => {
    const badges = railBadges(
      [
        thread("read"),
        thread("unread", { unread: true }),
        thread("approval", { status: "awaitingApproval" }),
        thread("failed", { status: "failed", unread: true }),
        thread("failedSeen", { status: "failed" }),
      ],
      now,
    );
    expect(badges.home).toEqual({ count: 3, waiting: 2 });
    expect(badges.chat).toBeUndefined();
  });

  it("leaves out threads archived or put off, unless they wait on the user", () => {
    const badges = railBadges(
      [
        thread("archived", { unread: true, archivedAt: now - 10 }),
        thread("later", { unread: true, laterUntil: now + 1000 }),
        thread("laterAsking", { status: "awaitingApproval", laterUntil: now + 1000 }),
        thread("back", { unread: true, laterUntil: now - 1000 }),
      ],
      now,
    );
    expect(badges.home).toEqual({ count: 2, waiting: 1 });
  });

  it("counts the chats waiting for an approval, and nothing when all is quiet", () => {
    expect(
      railBadges(
        [thread("asking", { mode: "chat", status: "awaitingApproval" }), thread("idle", { mode: "chat" })],
        now,
      ),
    ).toEqual({ chat: { count: 1, waiting: 1 } });
    expect(railBadges([thread("read")], now)).toEqual({});
  });

  it("says what it counts", () => {
    expect(badgeNote({ count: 3, waiting: 1 })).toBe("2 unread · 1 needs you");
    expect(badgeNote({ count: 2, waiting: 2 })).toBe("2 need you");
    expect(badgeNote({ count: 4, waiting: 0 })).toBe("4 unread");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(12)).toBe("9+");
  });
});
