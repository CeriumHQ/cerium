import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

describe("offline effort evaluation", () => {
  it("replays a live acknowledgement trace without inventing counterfactual outcomes", () => {
    const output = execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "../scripts/effort-eval.ts"),
        `--cases=${join(import.meta.dirname, "fixtures/effort-evaluation.jsonl")}`,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    expect(result.policyVersion).toBe("effort-v2");
    expect(result.report.map((row: { acceptable: number }) => row.acceptable)).toEqual([1, 0, 0]);
    expect(
      result.report.every(
        (row: { measured: number; succeeded: number }) => row.measured === 0 && row.succeeded === 0,
      ),
    ).toBe(true);
  });
});
