import type { ModelInfo, RosterMember, ThreadId } from "@cerium/protocol";
import type { ReviewFinding, ReviewRecord } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  chosenReviewer,
  coveredLines,
  findingComment,
  findingsHeadline,
  findingsOn,
  findingsUnder,
  latestReview,
  reviewerOptions,
} from "../src/features/review/model.ts";

const model = (provider: ModelInfo["provider"], id: string, label: string): ModelInfo =>
  ({ provider, id, label }) as ModelInfo;

const member = (provider: ModelInfo["provider"], id: string, label: string): RosterMember => ({
  model: model(provider, id, label),
  use: "",
  priority: 1,
});

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "f1",
  path: "src/a.ts",
  start: 11,
  end: 12,
  side: "new",
  severity: "high",
  title: "y is wrong",
  body: "It should stay 2.",
  lines: [
    { marker: "+", text: "  const y = 3;", number: 11 },
    { marker: " ", text: "  return x + y;", number: 12 },
  ],
  state: "open",
  ...overrides,
});

const review = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  id: "rev_1",
  threadId: "thr_1" as ThreadId,
  target: { _tag: "Changes", root: "C:\\repo" },
  label: "1 file changed",
  files: ["src/a.ts"],
  reviewer: { provider: "codex", model: "gpt-6-luna" },
  createdAt: 1,
  updatedAt: 1,
  state: "done",
  findings: [finding()],
  ...overrides,
});

describe("reviewer options", () => {
  const roster = [
    member("claude", "opus", "Opus"),
    member("codex", "gpt-6-luna", "GPT-6 Luna"),
    member("cursor", "composer-2.5", "Composer 2.5"),
  ];

  it("puts other harnesses first and leaves out those that can't run", () => {
    const options = reviewerOptions(roster, new Set(["claude", "codex"]), "claude");
    expect(options.map((option) => [option.label, option.other])).toEqual([
      ["GPT-6 Luna", true],
      ["Opus", false],
    ]);
    expect(chosenReviewer(options, undefined)?.label).toBe("GPT-6 Luna");
    expect(chosenReviewer(options, "claude/opus")?.label).toBe("Opus");
    expect(chosenReviewer(options, "cursor/composer-2.5")?.label).toBe("GPT-6 Luna");
    expect(chosenReviewer([], undefined)).toBeUndefined();
  });
});

describe("findings on a diff", () => {
  it("shows the open findings of the latest finished review of the scope, under their last line", () => {
    const older = review({ id: "rev_0", findings: [finding({ id: "old" })] });
    const running = review({ id: "rev_2", state: "running", findings: [] });
    const turn = review({
      id: "rev_t",
      target: { _tag: "Turn", root: "C:\\repo", turnId: "t1", before: "a", after: "b", paths: [] },
    });
    const reviews = [older, review(), running, turn];
    const placed = findingsOn(reviews, { _tag: "Changes", root: "c:/repo/" }, "src/a.ts");
    expect(placed.map(({ review: each }) => each.id)).toEqual(["rev_1"]);
    expect(findingsOn(reviews, { _tag: "Changes", root: "C:\\repo" }, "src/b.ts")).toEqual([]);
    expect(findingsOn(reviews, { _tag: "Turn", after: "b" }, "a.ts")).toHaveLength(1);
    expect(
      findingsOn(
        [review({ findings: [finding({ state: "dismissed" })] })],
        { _tag: "Changes", root: "C:\\repo" },
        "src/a.ts",
      ),
    ).toEqual([]);

    expect(findingsUnder(placed, { kind: "context", old: 11, new: 12 })).toHaveLength(1);
    expect(findingsUnder(placed, { kind: "added", new: 11 })).toHaveLength(0);
    expect([...coveredLines(placed)]).toEqual([11, 12]);
    expect(latestReview(reviews, { _tag: "Changes", root: "C:\\repo" })?.id).toBe("rev_2");
  });

  it("anchors a finding on removed lines by the old side's number", () => {
    const placed = findingsOn(
      [review({ findings: [finding({ side: "old", lines: [{ marker: "-", text: "gone", number: 11 }] })] })],
      { _tag: "Changes", root: "C:\\repo" },
      "src/a.ts",
    );
    expect(findingsUnder(placed, { kind: "removed", old: 11 })).toHaveLength(1);
    expect(findingsUnder(placed, { kind: "context", old: 11, new: 11 })).toHaveLength(0);
  });
});

describe("sending a finding", () => {
  it("is a comment on its lines, or on its place when it has none", () => {
    const comment = findingComment(finding(), "GPT-6 Luna");
    expect(comment.file).toEqual({ path: "src/a.ts", start: 11, end: 12, lines: finding().lines });
    expect(comment.quote).toBe("+   const y = 3;\n    return x + y;");
    expect(comment.text).toBe("GPT-6 Luna reviewed this: y is wrong\n\nIt should stay 2.");
    const loose = findingComment(finding({ lines: [], body: "" }), "GPT-6 Luna");
    expect(loose).toEqual({ quote: "src/a.ts:11-12", text: "GPT-6 Luna reviewed this: y is wrong" });
  });

  it("sums up what a review found", () => {
    expect(findingsHeadline(review())).toBe("1 finding, 1 high");
    expect(findingsHeadline(review({ findings: [] }))).toBe("No findings");
  });
});
