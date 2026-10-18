// Plans Cerium's automatic releases (docs/architecture.md §10): the version a nightly or stable
// build gets, whether it has anything to publish, and its release notes.
//
// Usage:
//   node scripts/release.ts nightly --build=<n> [--notes=<file>]
//   node scripts/release.ts stable [--commit=<sha>] [--version=<x.y.z>] [--notes=<file>]
//
// A nightly covers the commits pushed since the previous release, published as
// `<next version>-nightly.n<build, padded to six digits>` when one of them changes the app. The
// padded, letter-prefixed build sorts the same read as text as it does as a version: GitHub orders
// a day's releases by tag as text, so an unpadded `nightly.9` would sit above `nightly.13`, and a
// purely numeric identifier may not carry leading zeroes under semver, while an alphanumeric one
// may. A stable promotes the newest
// nightly's commit, versioned from its Conventional Commits since the last stable: a breaking change
// bumps the major (the minor before 1.0), a feature the minor, any other change that ships the
// patch. Its notes are the CHANGELOG.md entries added since the last stable. The plan is printed and,
// on GitHub Actions, written to $GITHUB_OUTPUT as `publish`, `version`, `tag`, `title` and `commit`.

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly nightly?: number | undefined;
}

export type Bump = "major" | "minor" | "patch";

/** Nightly tags before the padded build read `-nightly.<build>`; both spellings name one build. */
const tagPattern = /^v(\d+)\.(\d+)\.(\d+)(?:-nightly\.n?(\d+))?$/;
const subjectPattern = /^([a-z]+)(?:\([^)]*\))?(!)?: /;

/** Commit types whose changes reach the installed app; docs, test, ci and chore commits don't. */
const shippingTypes = new Set(["build", "feat", "fix", "perf", "refactor", "revert", "style"]);

const unsignedNote =
  "The installer is unsigned for now, so Windows SmartScreen asks before running it (More info → Run anyway).";

export const parseTag = (tag: string): Version | undefined => {
  const match = tagPattern.exec(tag);
  if (match === null) return undefined;
  const [, major, minor, patch, nightly] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    nightly: nightly === undefined ? undefined : Number(nightly),
  };
};

export const formatVersion = ({ major, minor, patch, nightly }: Version): string =>
  `${major}.${minor}.${patch}${nightly === undefined ? "" : `-nightly.n${String(nightly).padStart(6, "0")}`}`;

/** Semver precedence: a nightly comes before the release it leads up to. */
export const compareVersions = (a: Version, b: Version): number =>
  a.major - b.major ||
  a.minor - b.minor ||
  a.patch - b.patch ||
  (a.nightly ?? Number.MAX_SAFE_INTEGER) - (b.nightly ?? Number.MAX_SAFE_INTEGER);

/** The bump a range of commit subjects calls for, or undefined when none of them ships. */
export const bumpFor = (subjects: readonly string[]): Bump | undefined => {
  let bump: Bump | undefined;
  for (const subject of subjects) {
    const [, type = "", breaking] = subjectPattern.exec(subject) ?? [];
    if (breaking !== undefined) return "major";
    if (!shippingTypes.has(type)) continue;
    bump = type === "feat" ? "minor" : (bump ?? "patch");
  }
  return bump;
};

export const bumpVersion = ({ major, minor, patch }: Version, bump: Bump): Version => {
  // Before 1.0, a breaking change bumps the minor.
  if (bump === "major" && major > 0) return { major: major + 1, minor: 0, patch: 0 };
  if (bump === "patch") return { major, minor, patch: patch + 1 };
  return { major, minor: minor + 1, patch: 0 };
};

/** The entries under each heading of the changelog's Unreleased section, continuation lines included. */
export const unreleasedEntries = (changelog: string): Map<string, string[]> => {
  const sections = new Map<string, string[]>();
  let unreleased = false;
  let entries: string[] | undefined;
  for (const line of changelog.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      unreleased = /^## \[?unreleased\]?/i.test(line);
      entries = undefined;
    } else if (!unreleased) {
      continue;
    } else if (line.startsWith("### ")) {
      entries = [];
      sections.set(line.slice(4).trim(), entries);
    } else if (entries !== undefined && line.startsWith("- ")) {
      entries.push(line);
    } else if (entries !== undefined && entries.length > 0 && /^\s+\S/.test(line)) {
      entries[entries.length - 1] += `\n${line}`;
    }
  }
  return sections;
};

/** The Unreleased entries `after` has and `before` hadn't, as markdown grouped by heading. */
export const newEntries = (before: string, after: string): string => {
  const known = new Set([...unreleasedEntries(before).values()].flat());
  return [...unreleasedEntries(after)]
    .map(([heading, entries]) => [heading, entries.filter((entry) => !known.has(entry))] as const)
    .filter(([, entries]) => entries.length > 0)
    .map(([heading, entries]) => `### ${heading}\n\n${entries.join("\n")}`)
    .join("\n\n");
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const tryGit = (...args: string[]): string | undefined => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

interface Tag {
  readonly name: string;
  readonly version: Version;
}

const tagsMergedInto = (commit: string): Tag[] =>
  lines(git("tag", "--list", "v*", "--merged", commit)).flatMap((name) => {
    const version = parseTag(name);
    return version === undefined ? [] : [{ name, version }];
  });

const newest = (tags: readonly Tag[]): Tag | undefined =>
  tags.reduce<Tag | undefined>(
    (best, tag) => (best === undefined || compareVersions(tag.version, best.version) > 0 ? tag : best),
    undefined,
  );

const commitOf = (tag: string): string => git("rev-list", "-n", "1", tag);

const range = (from: string | undefined, to: string): string => (from === undefined ? to : `${from}..${to}`);

const subjects = (from: string | undefined, to: string): string[] =>
  lines(git("log", "--format=%s", range(from, to)));

const commitList = (from: string | undefined, to: string): string =>
  git("log", "--format=- %h %s", range(from, to));

/** The next stable version at a commit, from the commits since the last stable it contains. */
const nextStable = (commit: string) => {
  const lastStable = newest(tagsMergedInto(commit).filter((tag) => tag.version.nightly === undefined));
  const bump = bumpFor(subjects(lastStable?.name, commit));
  const base = lastStable?.version ?? { major: 0, minor: 0, patch: 0 };
  return { lastStable, bump, version: bumpVersion(base, bump ?? "patch") };
};

interface Release {
  readonly version: string;
  readonly title: string;
  readonly commit: string;
  readonly notes: string;
}

/** A nightly always has a release to package; `skip` says why it isn't published. */
interface Plan {
  readonly release?: Release;
  readonly skip?: string;
}

const planNightly = (build: number): Plan => {
  const commit = git("rev-parse", "HEAD");
  const version = formatVersion({ ...nextStable(commit).version, nightly: build });
  // The closest release tag, nightly or stable: the commits since it were pushed together.
  const previous = tryGit("describe", "--tags", "--abbrev=0", "--match", "v*", commit);
  const release = {
    version,
    title: `Cerium Nightly ${version}`,
    commit,
    notes: [
      `Nightly build of ${commit.slice(0, 7)} for testing. Cerium updates to it in place when Settings → Updates follows the nightly channel.`,
      unsignedNote,
      `### Commits since ${previous ?? "the first commit"}`,
      commitList(previous, commit),
    ].join("\n\n"),
  };
  if (previous !== undefined && commitOf(previous) === commit) {
    return { release, skip: `${previous} was already released from ${commit.slice(0, 7)}` };
  }
  if (bumpFor(subjects(previous, commit)) === undefined) {
    return { release, skip: `nothing that ships changed since ${previous ?? "the first commit"}` };
  }
  return { release };
};

const planStable = (options: { readonly commit?: string; readonly version?: string }): Plan => {
  let commit = options.commit;
  if (commit === undefined) {
    const nightly = newest(tagsMergedInto("HEAD").filter((tag) => tag.version.nightly !== undefined));
    if (nightly === undefined) return { skip: "there is no nightly to promote" };
    commit = commitOf(nightly.name);
  }
  const { lastStable, bump, version: computed } = nextStable(commit);
  if (lastStable !== undefined && commitOf(lastStable.name) === commit) {
    return { skip: `${lastStable.name} already released ${commit.slice(0, 7)}` };
  }

  let version = computed;
  if (options.version !== undefined) {
    const requested = parseTag(`v${options.version}`);
    if (requested === undefined || requested.nightly !== undefined) {
      throw new Error(`A stable version reads x.y.z, not "${options.version}".`);
    }
    if (lastStable !== undefined && compareVersions(requested, lastStable.version) <= 0) {
      throw new Error(`${options.version} doesn't come after the last stable, ${lastStable.name}.`);
    }
    version = requested;
  } else if (bump === undefined) {
    return { skip: `nothing that ships changed since ${lastStable?.name ?? "the start"}` };
  }

  const changelogAt = (rev: string | undefined) =>
    rev === undefined ? "" : (tryGit("show", `${rev}:CHANGELOG.md`) ?? "");
  const entries = newEntries(changelogAt(lastStable?.name), changelogAt(commit));
  const stable = formatVersion(version);
  return {
    release: {
      version: stable,
      title: `Cerium ${stable}`,
      commit,
      notes: [
        entries === "" ? "No changes were recorded in CHANGELOG.md." : entries,
        unsignedNote,
        `<details>\n<summary>Commits since ${lastStable?.name ?? "the start"}</summary>\n\n${commitList(lastStable?.name, commit)}\n\n</details>`,
      ].join("\n\n"),
    },
  };
};

const report = ({ release, skip }: Plan, notesFile: string | undefined) => {
  const publish = release !== undefined && skip === undefined;
  console.log(publish ? `Publishing ${release.title} from ${release.commit}.` : `Not publishing: ${skip}.`);
  const outputs: Record<string, string> = { publish: String(publish) };
  if (release !== undefined) {
    Object.assign(outputs, {
      version: release.version,
      tag: `v${release.version}`,
      title: release.title,
      commit: release.commit,
    });
    if (notesFile === undefined) console.log(`\n${release.notes}`);
    else writeFileSync(notesFile, `${release.notes}\n`);
  }
  const githubOutput = process.env["GITHUB_OUTPUT"];
  if (githubOutput !== undefined) {
    appendFileSync(
      githubOutput,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
};

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      build: { type: "string" },
      commit: { type: "string" },
      version: { type: "string" },
      notes: { type: "string" },
    },
  });
  // Workflows pass empty strings for inputs that weren't given.
  const given = (value: string | undefined) => (value === "" ? undefined : value);
  const [channel] = positionals;
  if (channel === "nightly") {
    const build = Number(values.build);
    if (!Number.isSafeInteger(build) || build < 0) throw new Error("A nightly needs --build=<n>.");
    report(planNightly(build), values.notes);
  } else if (channel === "stable") {
    const commit = given(values.commit);
    const version = given(values.version);
    report(
      planStable({
        ...(commit === undefined ? {} : { commit }),
        ...(version === undefined ? {} : { version }),
      }),
      values.notes,
    );
  } else {
    throw new Error(
      "Usage: node scripts/release.ts nightly --build=<n> | stable [--commit=<sha>] [--version=<x.y.z>]",
    );
  }
}
