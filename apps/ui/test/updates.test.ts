import { describe, expect, it } from "@effect/vitest";

import type { Updates, UpdateStatus } from "../src/backend/shell.ts";
import {
  channelLocked,
  checkedLabel,
  noticeVersion,
  releaseNotesUrl,
  statusText,
  versionParts,
} from "../src/features/updates/model.ts";

const updates = (status: UpdateStatus, extra: Partial<Updates> = {}): Updates => ({
  channel: "stable",
  version: "0.4.0",
  buildChannel: "stable",
  status,
  manual: false,
  ...extra,
});

describe("statusText", () => {
  it("names the version on offer", () => {
    expect(statusText(updates({ kind: "available", version: "0.5.0" }))).toBe("Cerium 0.5.0 is available.");
  });

  it("says where a build that can't install it gets the version on offer", () => {
    expect(statusText(updates({ kind: "available", version: "0.5.0" }, { manual: true }))).toContain(
      "downloads in your browser",
    );
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
    expect(statusText(waiting)).toContain("once one passes 0.5.0 nightly 3");
  });

  it("names a nightly on offer by its release and build", () => {
    expect(statusText(updates({ kind: "available", version: "0.8.0-nightly.n000006" }))).toBe(
      "Cerium 0.8.0 nightly 6 is available.",
    );
  });
});

describe("versionParts", () => {
  it("splits a nightly into its release and build, and leaves a stable whole", () => {
    expect(versionParts("0.8.0-nightly.n000006")).toEqual({ release: "0.8.0", build: 6 });
    expect(versionParts("0.5.0-nightly.3")).toEqual({ release: "0.5.0", build: 3 });
    expect(versionParts("0.8.0")).toEqual({ release: "0.8.0" });
  });

  it("tells unreadable releases from a network problem", () => {
    expect(statusText(updates({ kind: "unreachable", reason: "unpublished", checkedAt: 0 }))).toBe(
      "No stable releases to update from yet.",
    );
    expect(statusText(updates({ kind: "unreachable", reason: "offline", checkedAt: 0 }))).toBe(
      "Couldn't reach GitHub. Check your connection.",
    );
  });
});

describe("releaseNotesUrl", () => {
  it("links the GitHub release tagged with the version", () => {
    expect(releaseNotesUrl("0.5.0")).toBe("https://github.com/CeriumHQ/cerium/releases/tag/v0.5.0");
    expect(releaseNotesUrl("0.7.0-nightly.n000031")).toBe(
      "https://github.com/CeriumHQ/cerium/releases/tag/v0.7.0-nightly.n000031",
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
