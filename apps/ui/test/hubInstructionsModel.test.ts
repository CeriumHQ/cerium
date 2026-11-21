import { type HubInstructionFile } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  canBeCanonical,
  defaultInstructionSource,
  instructionSync,
  instructionTarget,
  type InstructionSelection,
} from "../src/features/settings/hubInstructionsModel.ts";

const file = (path: string, fields: Partial<HubInstructionFile> = {}): HubInstructionFile => ({
  path,
  revision: "missing",
  providers: [],
  supplemental: false,
  ...fields,
});
const source = file("AGENTS.md", { content: "Shared text", revision: "source" });
const copy = file("CLAUDE.md", { content: source.content!, revision: "copy" });
const linked = file("GEMINI.md", { content: source.content!, reference: source.path, revision: "link" });
const drift = file(".github/copilot-instructions.md", { content: "Different", revision: "drift" });
const missing = file(".claude/CLAUDE.md");
const broken = file(".cursorrules", { reference: "README.md", problem: "Broken link", revision: "broken" });
const inaccessible = file("AGENT.md", { problem: "Unreadable", revision: "unavailable" });
const scoped = file(".cursor/rules/one.mdc", { supplemental: true, content: "Local" });
const reference = file("docs/guide.md", { sourceOnly: true, content: "Custom canonical", revision: "doc" });
const files = [source, copy, linked, drift, missing, broken, inaccessible, scoped, reference];
const selection = (file: HubInstructionFile, replace = false): InstructionSelection => ({
  revision: file.revision,
  sourceRevision: source.revision,
  sourcePath: source.path,
  replace,
});
const request = (
  entries: [string, InstructionSelection][],
  draft?: { path: string; content: string; revision: string },
) => instructionSync("/project", files, source, draft, new Map(entries), "copy");

describe("Hub instruction model", () => {
  it("chooses an existing canonical file and ignores linked, supplemental and unreadable files", () => {
    const absent = file(source.path);
    expect(defaultInstructionSource([copy, source])).toBe(source);
    expect(defaultInstructionSource([linked, scoped, inaccessible, absent, copy])).toBe(copy);
    expect(defaultInstructionSource([linked, scoped, inaccessible, absent])).toBe(absent);
    expect(defaultInstructionSource([linked, scoped, inaccessible])).toBeUndefined();
    expect(canBeCanonical(reference)).toBe(true);
  });

  it("reports file status relative to the selected source", () => {
    expect(files.slice(0, 7).map((file) => instructionTarget(file, source, undefined).status)).toEqual([
      "canonical",
      "inSync",
      "linked",
      "diverged",
      "missing",
      "diverged",
      "unavailable",
    ]);
    expect(instructionTarget(scoped, source, undefined).selectable).toBe(false);
    expect(instructionTarget(reference, source, undefined).selectable).toBe(false);
    expect(instructionTarget(broken, source, undefined).selectable).toBe(true);
  });

  it("omits a no-op save and includes new or edited canonical text", () => {
    expect(request([])).toBeUndefined();
    expect(request([], { path: source.path, revision: source.revision, content: "" })?.source).toEqual({
      path: source.path,
      revision: source.revision,
      content: "",
    });
    expect(instructionSync("/project", [missing], missing, undefined, new Map(), "link")?.source).toEqual({
      path: missing.path,
      revision: "missing",
      content: "",
    });
  });

  it("requires explicit per-target replacement but updates previously matching copies with the draft", () => {
    expect(
      request([
        [copy.path, selection(copy)],
        [drift.path, selection(drift)],
      ]),
    ).toBeUndefined();
    const draft = { path: source.path, revision: source.revision, content: "Updated" };
    const targets = request(
      [
        [copy.path, selection(copy)],
        [drift.path, selection(drift, true)],
      ],
      draft,
    );
    expect(targets?.targets).toEqual([
      { path: copy.path, revision: copy.revision },
      { path: drift.path, revision: drift.revision, replace: true },
    ]);
    expect(targets?.source.content).toBe("Updated");
  });

  it("blocks stale drafts, targets, and replacement approval after the source changes", () => {
    expect(
      request([], { path: copy.path, revision: source.revision, content: "Wrong path" }),
    ).toBeUndefined();
    expect(request([], { path: source.path, revision: "old", content: "Stale" })).toBeUndefined();
    expect(request([[drift.path, { ...selection(drift, true), revision: "old" }]])).toBeUndefined();
    expect(request([[drift.path, { ...selection(drift, true), sourceRevision: "old" }]])).toBeUndefined();
    expect(request([[drift.path, { ...selection(drift, true), sourcePath: copy.path }]])).toBeUndefined();
    expect(request([["removed.md", selection(copy)]])).toBeUndefined();
  });
});
