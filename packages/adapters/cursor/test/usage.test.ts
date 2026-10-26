import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { hasUsageCommand, readUsageScreen, resetDay } from "../src/usageScreen.ts";

const NOW = Date.UTC(2026, 9, 26, 7, 0);
const OCT_30 = Date.UTC(2026, 9, 30);

const header = `
  Cursor Agent
  v2026.10.22-27dcf5f
  Tip: Try Cursor Grok 4.7 via /model, frontier intelligence at a fraction of the cost.
`;

const panel = (onDemand: string, detail: string, title = "Usage • Premium") => `${header}
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ${title.padEnd(102)}Resets Oct 30
 Monthly plan and on-demand usage

 Category        Current             Usage
 Included        15% used            ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
   Auto          15% used            ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
   API           1% used             █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 On-Demand       ${onDemand}

 ${detail}

 View in dashboard: cursor.com/dashboard?tab=usage

 Esc to close
`;

const pools = [
  { label: "Included · Auto", usedPercent: 15, resetsAt: OCT_30, resetDayOnly: true },
  { label: "Included · API", usedPercent: 1, resetsAt: OCT_30, resetDayOnly: true },
];

describe("Cursor CLI /usage screen", () => {
  it("reads the plan's pools, as the live panel draws them", () => {
    // Captured from cursor-agent 2026.10.22 on a Premium plan with no on-demand limit.
    const screen = panel(
      "$0                  ————————————————————————————————————————————————————————————————————————————————",
      "No monthly limit",
    );
    const state = readUsageScreen(screen, NOW);
    expect(state).toEqual({ _tag: "Report", report: { plan: "Premium", meters: pools } });
    expect(pools.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("adds a monthly on-demand cap as a spending meter", () => {
    const screen = panel(
      "$12.50 / $50        █████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
      "$37.50 remaining",
    );
    expect(readUsageScreen(screen, NOW)).toEqual({
      _tag: "Report",
      report: {
        plan: "Premium",
        meters: [
          ...pools,
          {
            label: "On-demand",
            usedPercent: 25,
            resetsAt: OCT_30,
            resetDayOnly: true,
            spend: { used: 12.5, limit: 50, currency: "USD" },
          },
        ],
      },
    });
  });

  it("works a cap the value column cut short out from what's left", () => {
    const screen = panel(
      "$1,234.56 / $5,00…  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
      "$3,765.44 remaining",
    );
    const state = readUsageScreen(screen, NOW);
    expect(state._tag === "Report" && state.report.meters[2]?.spend).toEqual({
      used: 1234.56,
      limit: 5000,
      currency: "USD",
    });
  });

  it("leaves out on-demand use that has no cap", () => {
    for (const [value, detail] of [
      ["Disabled", "On-demand usage is off"],
      ["$4.20", "No personal limit"],
      ["Unavailable", "On-demand limit unavailable"],
    ] as const) {
      const state = readUsageScreen(panel(`${value.padEnd(20)}${"—".repeat(80)}`, detail), NOW);
      expect(state._tag === "Report" && state.report.meters).toEqual(pools);
    }
  });

  it("drops the CLI's stand-in plan name", () => {
    const state = readUsageScreen(
      panel(`$0${" ".repeat(18)}${"—".repeat(80)}`, "No monthly limit", "Usage • Current plan"),
      NOW,
    );
    expect(state._tag === "Report" && state.report.plan).toBeUndefined();
  });

  it("reports no meters for an Enterprise plan's spend chart", () => {
    const screen = `${header}
 Usage • Enterprise                                                                                    Resets Nov 1
 Personal spend for the current billing period

 Current cycle     $212.40
 ▁▂▃▅▇

 Esc to close
`;
    expect(readUsageScreen(screen, NOW)).toEqual({
      _tag: "Report",
      report: { plan: "Enterprise", meters: [] },
    });
  });

  it("waits for a panel that is still being drawn", () => {
    const screen = panel("$0", "No monthly limit").replace("Esc to close", "");
    expect(readUsageScreen(screen, NOW)).toEqual({ _tag: "Waiting" });
    expect(readUsageScreen(`${header}\n  Loading usage data...`, NOW)).toEqual({ _tag: "Waiting" });
  });

  it("follows the CLI from its prompt to the command", () => {
    expect(readUsageScreen(`${header}\n  → Plan, search, build anything\n\n  Auto`, NOW)).toEqual({
      _tag: "Prompt",
      version: "2026.10.22",
    });
    expect(
      readUsageScreen(
        `${header}\n  → /usage\n\n   → /usage                    Show plan and on-demand usage\n     /context                  Show context usage breakdown`,
        NOW,
      ),
    ).toEqual({ _tag: "Offered" });
    expect(readUsageScreen("", NOW)).toEqual({ _tag: "Waiting" });
  });

  it("tells a signed-out CLI, a plan without usage and a failed load apart", () => {
    expect(readUsageScreen(`${header}\n  Not logged in. Run /login first.`, NOW)).toEqual({
      _tag: "LoggedOut",
    });
    expect(
      readUsageScreen(`${header}\n  Usage details are not available for this plan in the CLI.`, NOW),
    ).toEqual({ _tag: "NoPlan" });
    expect(
      readUsageScreen(
        `${header}\n  Failed to load usage data:\n  deadline exceeded\n  View usage settings at`,
        NOW,
      ),
    ).toEqual({ _tag: "Failed", message: "Cursor couldn't load its usage: deadline exceeded" });
  });
});

describe("resetDay", () => {
  it("finds the next day a label names, in UTC", () => {
    expect(resetDay("Resets Oct 30", NOW)).toBe(OCT_30);
    expect(resetDay("Resets Jan 3", NOW)).toBe(Date.UTC(2027, 0, 3));
    expect(resetDay("Resets Oct 25", NOW)).toBe(Date.UTC(2026, 9, 25));
  });

  it("reads the label in the machine's locale", () => {
    expect(resetDay("Resets 30 Oct", NOW, ["en-GB"])).toBe(OCT_30);
  });

  it("finds no day where the CLI names none", () => {
    expect(resetDay("Current period", NOW)).toBeUndefined();
    expect(resetDay("Resets someday", NOW)).toBeUndefined();
  });
});

describe("hasUsageCommand", () => {
  it("knows the versions that have /usage", () => {
    expect(hasUsageCommand("2026.10.22")).toBe(true);
    expect(hasUsageCommand("2026.7.13")).toBe(true);
    expect(hasUsageCommand("2026.7.1")).toBe(false);
  });
});
