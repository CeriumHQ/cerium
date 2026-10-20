// What the What's new panel shows: CHANGELOG.md bundled with the build, newest release first.

export interface ChangeGroup {
  /** "Added", "Changed", "Fixed", … */
  readonly heading: string;
  /** Newest first, continuation lines included. */
  readonly entries: ReadonlyArray<string>;
}

export interface Release {
  /** "Unreleased" or the version the changelog names. */
  readonly title: string;
  readonly date?: string;
  readonly groups: ReadonlyArray<ChangeGroup>;
}

const releaseHeading = /^## \[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?/;

/**
 * The releases of a Keep a Changelog file, in the order the file lists them (newest first). Entries
 * are appended to the end of their heading, so each group lists them newest first.
 */
export const parseChangelog = (changelog: string): ReadonlyArray<Release> => {
  const releases: Array<{
    title: string;
    date?: string;
    groups: Array<{ heading: string; entries: string[] }>;
  }> = [];
  let entries: string[] | undefined;
  for (const line of changelog.split(/\r?\n/)) {
    const release = releaseHeading.exec(line);
    if (release?.[1] !== undefined) {
      entries = undefined;
      releases.push({ title: release[1], ...(release[2] ? { date: release[2] } : {}), groups: [] });
    } else if (releases.length === 0) {
      continue;
    } else if (line.startsWith("### ")) {
      entries = [];
      releases.at(-1)?.groups.push({ heading: line.slice(4).trim(), entries });
    } else if (entries !== undefined && line.startsWith("- ")) {
      entries.push(line);
    } else if (entries !== undefined && entries.length > 0 && /^\s+\S/.test(line)) {
      entries[entries.length - 1] += `\n${line}`;
    }
  }
  return releases
    .map(({ groups, ...rest }) => ({
      ...rest,
      groups: groups
        .map(({ heading, entries: each }) => ({ heading, entries: each.toReversed() }))
        .filter((group) => group.entries.length > 0),
    }))
    .filter((release) => release.groups.length > 0);
};

/** How many entries of each group show before the rest is asked for. */
export const PREVIEW = 6;

/** How many entries `release` has beyond what its groups preview. */
export const hiddenCount = (release: Release): number =>
  release.groups.reduce((total, group) => total + Math.max(0, group.entries.length - PREVIEW), 0);

/** A release's groups as markdown, each group cut to its newest entries unless `all`. */
export const releaseMarkdown = (release: Release, all: boolean): string =>
  release.groups
    .map(
      ({ heading, entries }) => `### ${heading}\n\n${(all ? entries : entries.slice(0, PREVIEW)).join("\n")}`,
    )
    .join("\n\n");

/** "Unreleased" reads as the build's latest changes; versions as themselves. */
export const releaseTitle = (release: Release): string =>
  /^unreleased$/i.test(release.title) ? "Latest changes" : `Cerium ${release.title}`;

/** How many releases the panel lists. */
export const RELEASES = 3;

const LAST_SEEN_KEY = "cerium:whatsNewVersion";
export { LAST_SEEN_KEY };

/**
 * Whether the panel opens by itself: the build is a different one from the last that ran in this
 * window. A first run, with nothing remembered, only records the version.
 */
export const opensAfterUpdate = (lastSeen: string | undefined, version: string): boolean =>
  lastSeen !== undefined && lastSeen !== version && version !== "dev";
