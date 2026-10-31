import { describe, expect, it } from "@effect/vitest";

import {
  opensAfterUpdate,
  parseChangelog,
  seenValue,
  splitEntry,
  unseenIds,
} from "../src/features/whatsnew/model.ts";

const changelog = `# Changelog

Intro paragraph.

## [Unreleased]

### Added

- Find in a thread: Ctrl F opens a bar.
- Muse is back. The backend loads it
  again.

### Fixed

- A fix

### Added

- Find in a thread: listed twice.

## [0.2.0] - 2026-01-02

### Changed

- Older one.
`;

describe("parseChangelog", () => {
  it("lists every entry in file order, continuation lines joined", () => {
    expect(
      parseChangelog(changelog).map(({ kind, headline, detail }) => ({ kind, headline, detail })),
    ).toEqual([
      { kind: "added", headline: "Find in a thread", detail: "Ctrl F opens a bar." },
      { kind: "added", headline: "Muse is back", detail: "The backend loads it again." },
      { kind: "fixed", headline: "A fix", detail: undefined },
      { kind: "changed", headline: "Older one", detail: undefined },
    ]);
  });

  it("keeps the same id while the headline stays", () => {
    const [before] = parseChangelog("## x\n\n### Added\n\n- Muse is back. Old detail.\n");
    const [after] = parseChangelog("## x\n\n### Added\n\n- Muse is back. New detail.\n");
    expect(before?.id).toBe(after?.id);
  });
});

describe("splitEntry", () => {
  it("breaks at the first sentence or a colon after a phrase", () => {
    expect(splitEntry("Pushes and their CI checks in the thread. Agents push.")).toEqual({
      headline: "Pushes and their CI checks in the thread",
      detail: "Agents push.",
    });
    expect(splitEntry("Window has a slider: at the left the glass")).toEqual({
      headline: "Window has a slider",
      detail: "At the left the glass",
    });
  });

  it("doesn't break inside code or brackets, after a one-word label or before lowercase", () => {
    expect(splitEntry("`a. B` stays. Rest")).toEqual({ headline: "`a. B` stays", detail: "Rest" });
    expect(splitEntry("Builds (x64. Arm) ship. Rest")).toEqual({
      headline: "Builds (x64. Arm) ship",
      detail: "Rest",
    });
    expect(splitEntry("UI: a run is one card. Rest").headline).toBe("UI: a run is one card");
    expect(splitEntry("Models, e.g. sonnet, are listed. Rest").headline).toBe(
      "Models, e.g. sonnet, are listed",
    );
    expect(splitEntry("No sentence end")).toEqual({ headline: "No sentence end" });
  });
});

describe("unseenIds", () => {
  const changes = parseChangelog(changelog);

  it("is empty on a first run, then lists what wasn't there before", () => {
    expect(unseenIds(changes, undefined).size).toBe(0);
    expect(unseenIds(changes, seenValue(changes)).size).toBe(0);
    expect([...unseenIds(changes, seenValue(changes.slice(1)))]).toEqual([changes[0]?.id]);
  });
});

describe("opensAfterUpdate", () => {
  it("opens when a released build brings unseen changes", () => {
    expect(opensAfterUpdate(0, "0.2.0")).toBe(false);
    expect(opensAfterUpdate(2, "0.2.0")).toBe(true);
    expect(opensAfterUpdate(2, "dev")).toBe(false);
  });
});
