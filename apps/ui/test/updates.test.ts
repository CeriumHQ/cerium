import { describe, expect, it } from "@effect/vitest";

import type { Updates, UpdateStatus } from "../src/backend/shell.ts";
import {
  channelLocked,
  checkedLabel,
  noticeVersion,
  statusText,
  waitsForStable,
} from "../src/features/updates/model.ts";

const updates = (status: UpdateStatus, extra: Partial<Updates> = {}): Updates => ({
  channel: "stable",
  version: "0.4.0",
  buildChannel: "stable",
  status,
  ...extra,
});

describe("statusText", () => {
  it("names the version on offer", () => {
    expect(statusText(updates({ kind: "available", version: "0.5.0" }))).toBe("Cerium 0.5.0 is available.");
  });

  it("says which channel is current", () => {
    expect(statusText(updates({ kind: "current", checkedAt: 0 }, { channel: "nightly" }))).toBe(
      "You're on the latest nightly release.",
    );
  });

  it("tells a nightly that moved to stable that it waits for stable to pass it", () => {
    const waiting = updates(
      { kind: "current", checkedAt: 0 },
      { version: "0.5.0-nightly.3", buildChannel: "nightly" },
    );
    expect(waitsForStable(waiting)).toBe(true);
    expect(statusText(waiting)).toContain("once a stable release passes 0.5.0-nightly.3");
  });

  it("tells unreadable releases from a network problem", () => {
    expect(statusText(updates({ kind: "unreachable", reason: "unpublished", checkedAt: 0 }))).toContain(
      "updates are off for now",
    );
    expect(statusText(updates({ kind: "unreachable", reason: "offline", checkedAt: 0 }))).toContain(
      "Check your connection",
    );
  });
});

describe("checkedLabel", () => {
  it("counts minutes, then hours", () => {
    expect(checkedLabel(0, 30_000)).toBe("Checked just now");
    expect(checkedLabel(0, 60_000)).toBe("Checked 1 minute ago");
    expect(checkedLabel(0, 5 * 60_000)).toBe("Checked 5 minutes ago");
    expect(checkedLabel(0, 3 * 60 * 60_000)).toBe("Checked 3 hours ago");
  });
});

describe("the launch notice and the channel lock", () => {
  it("speaks up only once there is something to install", () => {
    expect(noticeVersion({ kind: "current", checkedAt: 0 })).toBeUndefined();
    expect(noticeVersion({ kind: "unreachable", reason: "offline", checkedAt: 0 })).toBeUndefined();
    expect(noticeVersion({ kind: "available", version: "0.5.0" })).toBe("0.5.0");
    expect(noticeVersion({ kind: "ready", version: "0.5.0" })).toBe("0.5.0");
  });

  it("keeps the channel while an update downloads or waits to install", () => {
    expect(channelLocked({ kind: "downloading", version: "0.5.0", percent: 10 })).toBe(true);
    expect(channelLocked({ kind: "ready", version: "0.5.0" })).toBe(true);
    expect(channelLocked({ kind: "available", version: "0.5.0" })).toBe(false);
  });
});
