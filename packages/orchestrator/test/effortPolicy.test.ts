import { describe, expect, it } from "@effect/vitest";

import {
  clipContext,
  effortState,
  selectEffort,
  supportedLevel,
  supportedProbabilities,
  validProbabilities,
  type EffortAnswer,
  type EffortQuestion,
} from "../src/effort.ts";

const levels = ["low", "medium", "high"] as const;
const question: EffortQuestion = {
  levels,
  state: { turn: { from: "user", text: "Continue implementing the plan" }, recent: [] },
};
const answer = (probabilities: number[], extra: Partial<EffortAnswer> = {}): EffortAnswer => ({
  probabilities,
  confidence: 0.7,
  ...extra,
});

describe("effort policy replay", () => {
  it("runs at the lowest level likely enough to do, leaning up when the answer is spread", () => {
    expect(selectEffort(question, answer([0.05, 0.1, 0.85]), "low", "medium")).toEqual({ effort: "high" });
    expect(selectEffort(question, answer([0.7, 0.2, 0.1]), "high", "medium")).toEqual({ effort: "low" });
    expect(selectEffort(question, answer([0.45, 0.3, 0.25]), "high", "medium")).toEqual({
      effort: "medium",
    });
  });
  it("comes down from a high level as readily as it goes up to one", () => {
    // Answers the decision model gave live, which v2 kept at Extra high for wanting 80% on one level.
    const five = { ...question, levels: ["low", "medium", "high", "xhigh", "max"] as const };
    const pick = (probabilities: number[]) =>
      selectEffort(five, answer(probabilities, { confidence: 0.6 }), "xhigh", "high").effort;
    expect(pick([0.11, 0.07, 0.75, 0.07, 0])).toBe("high");
    expect(pick([0.64, 0.19, 0.17, 0, 0])).toBe("low");
    expect(pick([0.56, 0.16, 0.26, 0.01, 0])).toBe("medium");
    expect(pick([0.03, 0.01, 0.39, 0.55, 0.02])).toBe("xhigh");
  });
  it.each([{ failed: true }, { stopReason: "error" }, { stopReason: "maxTurns" }])(
    "keeps the level after a failed turn: %j",
    (facts) => {
      const recovery = {
        ...question,
        state: {
          ...question.state,
          previousTurn: { toolCalls: 1, seconds: 1, filesChanged: 0, failed: false, ...facts },
        },
      };
      expect(selectEffort(recovery, answer([0.9, 0.05, 0.05]), "high", "medium")).toEqual({
        effort: "high",
        kept: "recovering",
      });
    },
  );
  it.each([{ toolErrors: 2 }, { stopReason: "steered" }, { stopReason: "interrupted" }])(
    "lowers the level after a turn that didn't fail: %j",
    (facts) => {
      const after = {
        ...question,
        state: {
          ...question.state,
          previousTurn: { toolCalls: 1, seconds: 1, filesChanged: 0, failed: false, ...facts },
        },
      };
      expect(selectEffort(after, answer([0.9, 0.05, 0.05]), "high", "medium").effort).toBe("low");
    },
  );
  it("runs at the fallback when the decision model can't tell", () => {
    expect(
      selectEffort(question, answer([0.95, 0.04, 0.01], { contextSufficient: 0.1 }), "low", "medium"),
    ).toEqual({ effort: "medium", kept: "fallback" });
    expect(selectEffort(question, answer([0.4, 0.3, 0.3], { confidence: 0.2 }), "high", "medium")).toEqual({
      effort: "medium",
      kept: "unsure",
    });
  });
  it("takes the fallback's next level up, or the model's highest", () => {
    expect(supportedLevel(["low", "medium", "high"], "minimal")).toBe("low");
    expect(supportedLevel(["low", "high"], "medium")).toBe("high");
    expect(supportedLevel(["low", "medium", "high"], "max")).toBe("high");
  });
  it("rejects malformed distributions rather than selecting low", () => {
    for (const probabilities of [
      [],
      [0, 0, 0],
      [-1, 1, 1],
      [NaN, 0, 1],
      [Infinity, 0, 0],
      [0.2, 0.2],
      [0.2, 0.2, 0.2],
    ]) {
      expect(validProbabilities(probabilities, 3)).toBe(false);
      expect(selectEffort(question, answer(probabilities), "low", "medium").effort).toBe("medium");
    }
  });
  it("projects difficulty onto sparse supported effort scales without losing mass", () => {
    expect(supportedProbabilities(["low", "high"], [0.1, 0.2, 0.3, 0.2, 0.1, 0.1])).toEqual([
      0.30000000000000004, 0.7,
    ]);
  });
  it("keeps the end of the previous reply and bounds each field", () => {
    const text = `request ${"x".repeat(5000)} next: repair the parser`;
    expect(clipContext(text, 1000).length).toBeLessThanOrEqual(1000);
    expect(
      effortState({ from: "user", text }, [{ sent: text, replied: text }], undefined).recent[0]?.replied,
    ).toContain("next: repair the parser");
  });
});
