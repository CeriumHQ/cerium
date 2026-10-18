import type { UpdateChannel, Updates, UpdateStatus } from "../../backend/shell.ts";

// What Settings → Updates and the launch notice say about the shell's updater
// (apps/desktop/src/updater.ts).

export const channelLabel: Record<UpdateChannel, string> = { stable: "Stable", nightly: "Nightly" };

/** "0.4.0" or "0.4.1-nightly.12", as Cerium names its builds. */
export const versionLabel = (version: string) => `Cerium ${version}`;

/** A nightly newer than stable's latest that now follows stable: it waits for stable to pass it. */
export const waitsForStable = (updates: Updates) =>
  updates.channel === "stable" && updates.buildChannel === "nightly" && updates.status.kind === "current";

/** One line on where the updater stands. */
export const statusText = (updates: Updates): string => {
  const { status } = updates;
  switch (status.kind) {
    case "unsupported":
      return "This is a development build. Only the installed app updates itself.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return waitsForStable(updates)
        ? `This nightly is newer than the latest stable release. Cerium moves to stable once a stable release passes ${updates.version}.`
        : `You're on the latest ${channelLabel[updates.channel].toLowerCase()} release.`;
    case "available":
      return `${versionLabel(status.version)} is available.`;
    case "downloading":
      return `Downloading ${versionLabel(status.version)}…`;
    case "ready":
      return `${versionLabel(status.version)} is ready. Restart Cerium to finish updating, or it installs when you quit.`;
    case "unreachable":
      return status.reason === "unpublished"
        ? `Cerium can't read ${channelLabel[updates.channel].toLowerCase()} releases yet, so updates are off for now.`
        : "Couldn't reach GitHub to check for updates. Check your connection and try again.";
    case "failed":
      return `Couldn't download ${versionLabel(status.version)}. Try again.`;
  }
};

/** When the updater last looked, for statuses that come from a finished check. */
export const checkedAt = (status: UpdateStatus): number | undefined =>
  status.kind === "current" || status.kind === "unreachable" ? status.checkedAt : undefined;

/** "Checked just now", "Checked 5 minutes ago", "Checked 3 hours ago". */
export const checkedLabel = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
};

/** A channel can't change while an update is downloading or waiting to install. */
export const channelLocked = (status: UpdateStatus) =>
  status.kind === "downloading" || status.kind === "ready";

/** The launch notice speaks up once there is something to install, until the user dismisses it. */
export const noticeVersion = (status: UpdateStatus): string | undefined =>
  status.kind === "available" ||
  status.kind === "downloading" ||
  status.kind === "ready" ||
  status.kind === "failed"
    ? status.version
    : undefined;
