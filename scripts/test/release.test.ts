import { describe, expect, it } from "vite-plus/test";

import {
  bumpFor,
  bumpVersion,
  compareVersions,
  formatVersion,
  newEntries,
  parseTag,
  unreleasedEntries,
} from "../release.ts";

describe("release versions", () => {
  it("reads stable and nightly tags and nothing else", () => {
    expect(parseTag("v0.4.1")).toEqual({ major: 0, minor: 4, patch: 1, nightly: undefined });
    expect(parseTag("v0.5.0-nightly.n000057")).toEqual({ major: 0, minor: 5, patch: 0, nightly: 57 });
    // Nightlies published before the build was padded keep their spelling.
    expect(parseTag("v0.5.0-nightly.57")).toEqual({ major: 0, minor: 5, patch: 0, nightly: 57 });
    expect(parseTag("0.4.1")).toBeUndefined();
    expect(parseTag("v0.4.1-beta.1")).toBeUndefined();
    expect(formatVersion({ major: 0, minor: 5, patch: 0, nightly: 57 })).toBe("0.5.0-nightly.n000057");
  });

  it("orders nightlies before the release they lead up to, and by build", () => {
    const tags = ["v0.5.0", "v0.5.0-nightly.9", "v0.4.0", "v0.5.0-nightly.57", "v0.5.1-nightly.60"];
    const sorted = tags
      .map((tag) => parseTag(tag))
      .filter((version) => version !== undefined)
      .sort(compareVersions)
      .map(formatVersion);
    expect(sorted).toEqual([
      "0.4.0",
      "0.5.0-nightly.n000009",
      "0.5.0-nightly.n000057",
      "0.5.0",
      "0.5.1-nightly.n000060",
    ]);
  });

  it("writes nightly builds so reading them as text orders them as versions", () => {
    // GitHub orders a day's releases by tag as text, where nightly.9 would beat nightly.13.
    const builds = [9, 13, 100, 999, 1000].map((nightly) =>
      formatVersion({ major: 0, minor: 5, patch: 0, nightly }),
    );
    expect([...builds].sort()).toEqual(builds);
  });

  it("bumps from the commits that ship", () => {
    expect(bumpFor(["docs: explain", "ci: cache", "test(ui): cover", "chore: tidy"])).toBeUndefined();
    expect(bumpFor(["docs: explain", "style(ui): tint", "fix(rpc): retry"])).toBe("patch");
    expect(bumpFor(["fix(rpc): retry", "feat(ui): settings", "build: bump effect"])).toBe("minor");
    expect(bumpFor(["feat(ui): settings", "refactor(store)!: new schema"])).toBe("major");
    expect(bumpFor(["Merge branch 'main'", "not conventional"])).toBeUndefined();
  });

  it("treats a breaking change before 1.0 as a minor bump", () => {
    const base = { major: 0, minor: 4, patch: 2 };
    expect(bumpVersion(base, "patch")).toEqual({ major: 0, minor: 4, patch: 3 });
    expect(bumpVersion(base, "minor")).toEqual({ major: 0, minor: 5, patch: 0 });
    expect(bumpVersion(base, "major")).toEqual({ major: 0, minor: 5, patch: 0 });
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});

describe("release notes", () => {
  const before = `# Changelog

## [Unreleased]

### Added

- Settings.
- Harness logins.

### Fixed

- A crash.

## [0.1.0] - 2026-10-01

### Added

- Old entry.
`;

  const after = `# Changelog

## [Unreleased]

### Added

- Settings.
- Harness logins.
- CI on GitHub Actions,
  with nightlies.

### Changed

- Faster startup.

### Fixed

- A crash.

## [0.1.0] - 2026-10-01

### Added

- Old entry.
- Not unreleased.
`;

  it("reads only the Unreleased section, joining continuation lines", () => {
    expect([...unreleasedEntries(after)]).toEqual([
      ["Added", ["- Settings.", "- Harness logins.", "- CI on GitHub Actions,\n  with nightlies."]],
      ["Changed", ["- Faster startup."]],
      ["Fixed", ["- A crash."]],
    ]);
  });

  it("lists the entries added since the last stable, by heading", () => {
    expect(newEntries(before, after)).toBe(
      "### Added\n\n- CI on GitHub Actions,\n  with nightlies.\n\n### Changed\n\n- Faster startup.",
    );
    expect(newEntries(after, after)).toBe("");
    expect(newEntries("", before)).toBe(
      "### Added\n\n- Settings.\n- Harness logins.\n\n### Fixed\n\n- A crash.",
    );
  });
});
