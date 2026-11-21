import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { OpenCodeUsageLimits, toOpenCodeReport } from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(OpenCodeUsageLimits);

describe("toOpenCodeReport", () => {
  it("reports OpenCode Go rolling, weekly, and monthly meters", () => {
    const report = toOpenCodeReport(
      decode({
        location: { directory: "/tmp/work" },
        data: {
          workspace: { id: "org_123", name: "Personal", usageURL: "https://opencode.ai/console" },
          go: {
            rolling: { percent: 19.5, limited: false, resetsAt: 1_795_010_000_000 },
            weekly: { percent: 42, limited: false, resetsAt: 1_795_400_000_000 },
            monthly: { percent: 100, limited: true, resetsAt: 1_796_000_000_000 },
          },
          budgets: [],
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        plan: "go",
        meters: [
          {
            label: "5-hour limit",
            usedPercent: 19.5,
            resetsAt: 1_795_010_000_000,
            windowMinutes: 300,
          },
          {
            label: "Weekly limit",
            usedPercent: 42,
            resetsAt: 1_795_400_000_000,
            windowMinutes: 10_080,
          },
          {
            label: "Monthly limit",
            usedPercent: 100,
            resetsAt: 1_796_000_000_000,
            level: "critical",
          },
        ],
      }),
    );
    expect(Option.isSome(report) && report.value.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("reports Console budgets as USD spending meters", () => {
    const report = toOpenCodeReport(
      decode({
        data: {
          budgets: [
            {
              id: "b1",
              limit: 50,
              spent: 12.5,
              coverage: "all",
              models: [],
              vendors: [],
              resetsAt: 1_796_000_000_000,
            },
            {
              id: "b2",
              limit: 20,
              spent: 10,
              coverage: "models",
              models: [{ name: "Claude Opus" }],
              vendors: [],
              resetsAt: 1_796_000_000_000,
            },
          ],
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        meters: [
          {
            label: "Console budget",
            usedPercent: 25,
            resetsAt: 1_796_000_000_000,
            spend: { used: 12.5, limit: 50, currency: "USD" },
          },
          {
            label: "Budget · Claude Opus",
            usedPercent: 50,
            resetsAt: 1_796_000_000_000,
            spend: { used: 10, limit: 20, currency: "USD" },
          },
        ],
      }),
    );
  });

  it("reports nothing when signed out or when Console has neither Go nor budgets", () => {
    expect(toOpenCodeReport(decode({ data: null }))).toEqual(Option.none());
    expect(toOpenCodeReport(decode({ data: { budgets: [] } }))).toEqual(Option.none());
  });
});
