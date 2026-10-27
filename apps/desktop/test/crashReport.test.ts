import { describe, expect, it } from "@effect/vitest";

import { asCrashReport, errorOf, fingerprintOf, limitKeyOf, reportLimiter } from "../src/crashReport.ts";

describe("asCrashReport", () => {
  it("takes a report in a known category, from the process it came from", () => {
    expect(
      asCrashReport(
        {
          process: "main",
          category: "harness",
          kind: "start",
          name: "HarnessFailure",
          message: "boom",
          stack: "s",
        },
        "backend",
      ),
    ).toEqual({
      process: "backend",
      category: "harness",
      kind: "start",
      name: "HarnessFailure",
      message: "boom",
      stack: "s",
    });
    expect(asCrashReport({ category: "telemetry", name: "x", message: "y" }, "renderer")).toBeUndefined();
    expect(asCrashReport("boom", "renderer")).toBeUndefined();
  });

  it("keeps only the context it knows, of plain values", () => {
    const report = asCrashReport(
      {
        category: "relay",
        name: "Error",
        message: "closed",
        context: { code: 1011, harness: "claude", folder: "C:\\work", nested: { a: 1 } },
      },
      "backend",
    );
    expect(report?.context).toEqual({ code: 1011, harness: "claude" });
    expect(
      asCrashReport({ category: "relay", name: "E", message: "m", context: { folder: "x" } }, "backend"),
    ).not.toHaveProperty("context");
  });

  it("names an error without a name, and cuts what's too long", () => {
    const report = asCrashReport({ category: "render", message: "m".repeat(5_000) }, "renderer");
    expect(report?.name).toBe("Error");
    expect(report?.message).toHaveLength(2_000);
  });
});

describe("reportLimiter", () => {
  it("lets the same failure through once in a while, and stops after a run's worth", () => {
    const allowed = reportLimiter(1_000, 3);
    expect(allowed("a", 0)).toBe(true);
    expect(allowed("a", 500)).toBe(false);
    expect(allowed("b", 500)).toBe(true);
    expect(allowed("a", 1_500)).toBe(true);
    expect(allowed("c", 1_600)).toBe(false);
  });
});

describe("a report's error", () => {
  const report = {
    process: "renderer",
    category: "render",
    kind: "pane",
    name: "TypeError",
    message: "x is undefined",
    stack: "TypeError: x is undefined\n    at Transcript (app:///ui/dist/assets/index.js:1:2)",
  } as const;

  it("carries the reporting process's name, message and stack", () => {
    const error = errorOf(report);
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("x is undefined");
    expect(error.stack).toBe(report.stack);
    expect(errorOf({ ...report, stack: undefined } as never).stack).toBeUndefined();
  });

  it("groups by Sentry's own grouping within its process, category and kind", () => {
    expect(fingerprintOf(report)).toEqual(["{{ default }}", "renderer", "render", "pane"]);
    expect(limitKeyOf(report)).toBe("renderer|render|pane|TypeError|x is undefined");
  });
});
