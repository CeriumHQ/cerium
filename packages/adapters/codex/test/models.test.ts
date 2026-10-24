import { describe, expect, it } from "@effect/vitest";

import { toModelInfo } from "../src/models.ts";
import type { Model } from "../src/protocol/v2/Model.ts";

const model = (slug: string) =>
  ({
    model: slug,
    displayName: slug,
    description: "",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "low",
    isDefault: false,
  }) as unknown as Model;

describe("toModelInfo", () => {
  it("marks only models measured keeping the prompt cache across an effort switch", () => {
    expect(toModelInfo(model("gpt-6-luna")).cacheSafeEffort).toBe(true);
    expect(toModelInfo(model("gpt-5.6-terra")).cacheSafeEffort).toBeUndefined();
  });
});
