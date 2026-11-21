import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { AntigravityStatusLine, toAntigravityReport } from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(AntigravityStatusLine);
const NOW = Date.UTC(2026, 10, 21, 17, 0, 0);

describe("toAntigravityReport", () => {
  it("orders Gemini and third-party 5-hour/weekly buckets and skips disabled ones", () => {
    const report = toAntigravityReport(
      decode({
        plan_tier: "Pro",
        agent_state: "idle",
        quota: {
          "3p-weekly": {
            remaining_fraction: 0.4,
            reset_time: "2026-11-28T00:00:00Z",
          },
          "gemini-weekly": {
            remaining_fraction: 0.9378,
            reset_time: "2026-11-28T07:50:32Z",
          },
          "gemini-5h": {
            remaining_fraction: 0.75,
            reset_in_seconds: 3600,
          },
          "3p-5h": {
            remaining_fraction: 0.5,
            disabled: true,
          },
        },
      }),
      NOW,
    );
    expect(report).toEqual(
      Option.some({
        plan: "Pro",
        meters: [
          {
            label: "5-hour limit · Gemini",
            usedPercent: 25,
            resetsAt: NOW + 3_600_000,
            windowMinutes: 300,
          },
          {
            label: "Weekly limit · Gemini",
            usedPercent: 6.2,
            resetsAt: Date.UTC(2026, 10, 28, 7, 50, 32),
            windowMinutes: 10_080,
          },
          {
            label: "Weekly limit · Claude & GPT",
            usedPercent: 60,
            resetsAt: Date.UTC(2026, 10, 28, 0, 0, 0),
            windowMinutes: 10_080,
          },
        ],
      }),
    );
    expect(Option.isSome(report) && report.value.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("returns None when no active quota buckets are present", () => {
    expect(toAntigravityReport(decode({ plan_tier: "Pro", quota: null }), NOW)).toEqual(Option.none());
    expect(
      toAntigravityReport(decode({ quota: { "gemini-5h": { remaining_fraction: 1, disabled: true } } }), NOW),
    ).toEqual(Option.none());
  });
});
