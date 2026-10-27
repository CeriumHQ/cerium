import { describe, expect, it } from "@effect/vitest";

import {
  clipContext,
  effortState,
  selectEffort,
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
  confidence: 0.1,
  ...extra,
});

describe("effort policy replay", () => {
  it("does not treat distribution confidence as accuracy", () => {
    expect(selectEffort(question, answer([0.05, 0.1, 0.85]), "low", "medium")).toEqual({
      effort: "high",
      accepted: true,
    });
  });
  it("needs stronger evidence to downgrade", () => {
    expect(selectEffort(question, answer([0.7, 0.2, 0.1]), "high", "medium")).toEqual({
      effort: "high",
      accepted: false,
    });
    expect(selectEffort(question, answer([0.85, 0.1, 0.05]), "high", "medium")).toEqual({
      effort: "low",
      accepted: true,
    });
  });
  it.each([{ failed: true }, { toolErrors: 1 }, { stopReason: "steered" }, { stopReason: "maxTurns" }])(
    "preserves recovery effort for %j",
    (facts) => {
      const recovery = {
        ...question,
        state: {
          ...question.state,
          previousTurn: { toolCalls: 1, seconds: 1, filesChanged: 0, failed: false, ...facts },
        },
      };
      expect(selectEffort(recovery, answer([0.9, 0.05, 0.05]), "high", "medium").effort).toBe("high");
    },
  );
  it("uses the stable baseline when a follow-up has no identifiable task", () => {
    expect(
      selectEffort(question, answer([0.95, 0.04, 0.01], { contextSufficient: 0.1 }), "low", "medium"),
    ).toEqual({ effort: "medium", accepted: false });
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
