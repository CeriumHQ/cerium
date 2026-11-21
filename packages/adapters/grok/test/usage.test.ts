import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { parseGrokReset, readGrokUsageScreen } from "../src/usageScreen.ts";

const NOW = new Date(2026, 10, 21, 20, 0, 0, 0).getTime();

const LIVE_PANEL = `
  /p/v/f/_/f/T/tmp.6tGHT9wOnu                                                   1.3K / 256K │ [Dashboard]
                        ┌─────────────────────────────────────────────────────────────────── [✗] ─┐
                        │  Context usage  Usage limit  Session info                               │
                        │─────────────────────────────────────────────────────────────────────────│
                        │  Weekly limit (SuperGrok)                                               │
                        │                                                                         │
                        │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1%                                     │
                        │  Resets: November 27, 04:13                                             │
                        │                                                                         │
                        │  Session usage: no model calls yet in this session.                     │
                        │              Tab switch  |  ↑/↓ scroll  |  c copy session ID  |  Esc close │
                        └─────────────────────────────────────────────────────────────────────────┘
`;

describe("Grok Build /usage screen", () => {
  it("parses the live SuperGrok weekly limit panel", () => {
    const state = readGrokUsageScreen(LIVE_PANEL, NOW);
    expect(state).toEqual({
      _tag: "Report",
      report: {
        plan: "SuperGrok",
        meters: [
          {
            label: "Weekly limit",
            usedPercent: 1,
            resetsAt: new Date(2026, 10, 27, 4, 13, 0, 0).getTime(),
            windowMinutes: 10_080,
          },
        ],
      },
    });
    expect(state._tag === "Report" && state.report.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("walks the trust prompt, input prompt, and /usage autocomplete states", () => {
    expect(readGrokUsageScreen("Do you trust the contents of this directory?\nYes, proceed y", NOW)).toEqual({
      _tag: "Trust",
    });
    expect(readGrokUsageScreen("│ ❯ \n╰─── Grok 4.7 ─╯", NOW)).toEqual({ _tag: "Prompt" });
    expect(readGrokUsageScreen("  ❯ /usage View usage\n│ ❯ /usage │", NOW)).toEqual({ _tag: "Offered" });
    expect(readGrokUsageScreen("Sign in to Grok to continue", NOW)).toEqual({ _tag: "LoggedOut" });
  });

  it("waits on a half-drawn panel and recognizes plans with no limits", () => {
    expect(readGrokUsageScreen(LIVE_PANEL.replace("Esc close", ""), NOW)).toEqual({ _tag: "Waiting" });
    const noPlan = `
      ┌───────────────────────────────────┐
      │  Usage limit                      │
      │  No usage limit for API key users │
      │  Esc close                        │
      └───────────────────────────────────┘
    `;
    expect(readGrokUsageScreen(noPlan, NOW)).toEqual({ _tag: "NoPlan" });
  });
});

describe("parseGrokReset", () => {
  it("parses absolute, AM/PM, year-rollover, relative, and ISO reset timestamps", () => {
    expect(parseGrokReset("November 27, 04:13", NOW)).toBe(new Date(2026, 10, 27, 4, 13, 0, 0).getTime());
    expect(parseGrokReset("Jan 3, 2:30 PM", NOW)).toBe(new Date(2027, 0, 3, 14, 30, 0, 0).getTime());
    expect(parseGrokReset("in 2h 15m", NOW)).toBe(NOW + (2 * 60 + 15) * 60_000);
    expect(parseGrokReset("2026-11-27T04:13:00Z", NOW)).toBe(Date.UTC(2026, 10, 27, 4, 13));
    expect(parseGrokReset("soon", NOW)).toBeUndefined();
  });
});
