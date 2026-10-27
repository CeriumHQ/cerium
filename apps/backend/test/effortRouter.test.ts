import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { DecisionResponse } from "../src/effortRouter.ts";

describe("decision wire validation", () => {
  const response = (probability: number, confidence = 0.8, context = 0.9) => ({
    answers: {
      effort: { probabilities: { "0": probability }, confidence },
      task: { choice: "investigate" },
      context: { noul: context },
    },
  });
  it("accepts sparse distributions and independent task/context judgments", () => {
    expect(Option.isSome(Schema.decodeUnknownOption(DecisionResponse)(response(1)))).toBe(true);
  });
  it("rejects negative, out-of-range and nonfinite probabilities and confidence", () => {
    for (const p of [-0.1, 1.1, NaN, Infinity]) {
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(p)))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(1, p)))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(1, 0.8, p)))).toBe(true);
    }
  });
});
