import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  DevinUserStatus,
  parseDevinCredentials,
  toDevinReport,
  validateDevinServerUrl,
} from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(DevinUserStatus);

describe("Devin credentials validation", () => {
  it("parses valid top-level credentials on allowlisted Cognition/Devin HTTPS hosts", () => {
    const toml = `
# Devin CLI credentials
windsurf_api_key = "sk-devin-test-key"
api_server_url = "https://server.self-serve.devin.ai/"

[other]
api_server_url = "https://evil.example.com"
`;
    expect(parseDevinCredentials(toml)).toEqual({
      apiKey: "sk-devin-test-key",
      serverUrl: "https://server.self-serve.devin.ai",
    });
  });

  it("rejects non-HTTPS, credential-bearing, query-bearing, and untrusted hosts", () => {
    expect(validateDevinServerUrl("http://api.devin.ai")).toBeUndefined();
    expect(validateDevinServerUrl("https://evil.example.com")).toBeUndefined();
    expect(validateDevinServerUrl("https://devin.ai.evil.com")).toBeUndefined();
    expect(validateDevinServerUrl("https://user:pass@api.devin.ai")).toBeUndefined();
    expect(validateDevinServerUrl("https://api.devin.ai?foo=bar")).toBeUndefined();
    expect(validateDevinServerUrl("https://api.cognition.ai/v1/")).toBe("https://api.cognition.ai/v1");
  });
});

describe("toDevinReport", () => {
  it("maps daily and weekly quota windows including protobuf zero-omitted exhausted windows", () => {
    const report = toDevinReport(
      decode({
        planInfo: { planName: "Pro" },
        userStatus: {
          planStatus: {
            dailyQuotaResetAtUnix: "1795100000",
            weeklyQuotaRemainingPercent: 72.5,
            weeklyQuotaResetAtUnix: 1_795_500_000,
          },
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        plan: "Pro",
        meters: [
          {
            label: "Daily limit",
            usedPercent: 100,
            windowMinutes: 1440,
            resetsAt: 1_795_100_000_000,
          },
          {
            label: "Weekly limit",
            usedPercent: 27.5,
            windowMinutes: 10_080,
            resetsAt: 1_795_500_000_000,
          },
        ],
      }),
    );
    expect(Option.isSome(report) && report.value.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("maps enterprise ACUs and falls back to legacy prompt credits", () => {
    const enterprise = toDevinReport(
      decode({
        userStatus: {
          planStatus: {
            planInfo: { planName: "Enterprise" },
            planEnd: "2026-12-01T00:00:00Z",
            acuConsumed: 15,
            acuLimit: 100,
          },
        },
      }),
    );
    expect(enterprise).toEqual(
      Option.some({
        plan: "Enterprise",
        meters: [
          {
            label: "Monthly ACUs",
            usedPercent: 15,
            resetsAt: Date.UTC(2026, 11, 1),
          },
        ],
      }),
    );

    const legacy = toDevinReport(
      decode({
        planInfo: { planName: "Teams", monthlyPromptCredits: 500 },
        userStatus: {
          planStatus: {
            availablePromptCredits: 375,
            planEnd: "2026-12-01T00:00:00Z",
          },
        },
      }),
    );
    expect(legacy).toEqual(
      Option.some({
        plan: "Teams",
        meters: [
          {
            label: "Prompt credits",
            usedPercent: 25,
            resetsAt: Date.UTC(2026, 11, 1),
          },
        ],
      }),
    );
  });

  it("returns None when planStatus has no meters", () => {
    expect(toDevinReport(decode({ userStatus: { planStatus: {} } }))).toEqual(Option.none());
  });
});
