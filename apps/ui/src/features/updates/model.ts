import type { UpdateChannel, Updates, UpdateStatus } from "../../backend/shell.ts";

// What Settings → Updates and the launch notice say about the shell's updater
// (apps/desktop/src/updater.ts).

export const channelLabel: Record<UpdateChannel, string> = { stable: "Stable", nightly: "Nightly" };

/** "0.4.0", or "0.4.1-nightly.n000012" split into its release and build number. */
export const versionParts = (version: string): { release: string; build?: number } => {
  const match = /^(\d+\.\d+\.\d+)-nightly\.n?(\d+)$/.exec(version);
  return match ? { release: match[1]!, build: Number(match[2]) } : { release: version };
};

/** "0.4.0" or "0.4.1 nightly 12": a build's version as people read it. */
export const shortVersion = (version: string) => {
  const { release, build } = versionParts(version);
  return build === undefined ? release : `${release} nightly ${build}`;
};

/** "Cerium 0.4.0" or "Cerium 0.4.1 nightly 12". */
export const versionLabel = (version: string) => `Cerium ${shortVersion(version)}`;

/** A nightly newer than stable's latest that now follows stable: it waits for stable to pass it. */
const waitsForStable = (updates: Updates) =>
  updates.channel === "stable" && updates.buildChannel === "nightly" && updates.status.kind === "current";

/** One line on where the updater stands. */
export const statusText = (updates: Updates): string => {
  const { status } = updates;
  switch (status.kind) {
    case "unsupported":
      return "A development build. Only the installed app updates itself.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return waitsForStable(updates)
        ? `Ahead of the latest stable release. Cerium moves to stable once one passes ${shortVersion(updates.version)}.`
        : `You're on the latest ${channelLabel[updates.channel].toLowerCase()} release.`;
    case "available":
      return updates.manual
        ? `${versionLabel(status.version)} is available. It downloads in your browser; drag it into Applications.`
        : `${versionLabel(status.version)} is available.`;
    case "downloading":
      return `Downloading ${versionLabel(status.version)}…`;
    case "ready":
      return `${versionLabel(status.version)} is ready. It installs when you restart or quit.`;
    case "installing":
      return `Restarting to install ${versionLabel(status.version)}…`;
    case "unreachable":
      return status.reason === "unpublished"
        ? `No ${channelLabel[updates.channel].toLowerCase()} releases to update from yet.`
        : "Couldn't reach GitHub. Check your connection.";
    case "failed":
      return `Couldn't download ${versionLabel(status.version)}.`;
  }
};

/** A version's release page, which says what changed in it. */
export const releaseNotesUrl = (version: string) =>
  `https://github.com/CeriumHQ/cerium/releases/tag/v${version}`;

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

/** A channel can't change while an update is downloading, waiting to install or installing. */
export const channelLocked = (status: UpdateStatus) =>
  status.kind === "downloading" || status.kind === "ready" || status.kind === "installing";

/** The release on offer, from the check that found it to the restart that installs it. */
export const offerVersion = (status: UpdateStatus): string | undefined =>
  status.kind === "available" ||
  status.kind === "downloading" ||
  status.kind === "ready" ||
  status.kind === "installing" ||
  status.kind === "failed"
    ? status.version
    : undefined;

/**
 * The launch notice speaks up once there is something for the user to do, until they dismiss it: an
 * update that downloads by itself says nothing before it's ready to install.
 */
export const noticeVersion = (updates: Updates): string | undefined => {
  const { status } = updates;
  const unattended = updates.autoDownload && !updates.manual;
  return unattended && (status.kind === "available" || status.kind === "downloading")
    ? undefined
    : offerVersion(status);
};
