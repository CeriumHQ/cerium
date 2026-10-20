import { describe, expect, it } from "@effect/vitest";

import {
  hiddenCount,
  opensAfterUpdate,
  parseChangelog,
  PREVIEW,
  releaseMarkdown,
  releaseTitle,
} from "../src/features/whatsnew/model.ts";

const changelog = `# Changelog

## [Unreleased]

### Added

- first
- second
  continued

### Fixed

- a fix

## [0.2.0] - 2026-01-02

### Changed

- older
`;

describe("parseChangelog", () => {
  it("lists releases as the file does, entries newest first", () => {
    const [unreleased, older] = parseChangelog(changelog);
    expect(unreleased?.title).toBe("Unreleased");
    expect(unreleased?.groups).toEqual([
      { heading: "Added", entries: ["- second\n  continued", "- first"] },
      { heading: "Fixed", entries: ["- a fix"] },
    ]);
    expect(older).toMatchObject({ title: "0.2.0", date: "2026-01-02" });
  });

  it("skips releases without entries", () => {
    expect(parseChangelog("## [Unreleased]\n\n## [0.1.0]\n\n### Added\n\n- x\n")).toHaveLength(1);
  });
});

describe("releaseMarkdown", () => {
  const many = `## [Unreleased]\n\n### Added\n\n${Array.from({ length: PREVIEW + 2 }, (_, i) => `- e${i}`).join("\n")}\n`;
  const [release] = parseChangelog(many);

  it("cuts each group to its newest entries until all are asked for", () => {
    expect(hiddenCount(release!)).toBe(2);
    expect(releaseMarkdown(release!, false)).not.toContain("- e0");
    expect(releaseMarkdown(release!, false)).toContain(`- e${PREVIEW + 1}`);
    expect(releaseMarkdown(release!, true)).toContain("- e0");
  });
});

describe("releaseTitle", () => {
  it("names unreleased changes and versions", () => {
    expect(releaseTitle({ title: "Unreleased", groups: [] })).toBe("Latest changes");
    expect(releaseTitle({ title: "0.2.0", groups: [] })).toBe("Cerium 0.2.0");
  });
});

describe("opensAfterUpdate", () => {
  it("opens only when a different build ran before", () => {
    expect(opensAfterUpdate(undefined, "0.2.0")).toBe(false);
    expect(opensAfterUpdate("0.2.0", "0.2.0")).toBe(false);
    expect(opensAfterUpdate("0.1.0", "0.2.0")).toBe(true);
    expect(opensAfterUpdate("0.1.0", "dev")).toBe(false);
  });
});
