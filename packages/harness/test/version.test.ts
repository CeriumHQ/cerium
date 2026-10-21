import { describe, expect, it } from "@effect/vitest";

import { classifyVersion, compareVersions, parseVersion } from "../src/index.ts";

describe("parseVersion", () => {
  it("extracts the version from CLI banners", () => {
    expect(parseVersion("2.1.301 (Claude Code)")).toBe("2.1.301");
    expect(parseVersion("codex-cli 0.98.0")).toBe("0.98.0");
    expect(parseVersion("no version here")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("2.1.10", "2.1.9")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("1.4.10", "1.4.10")).toBe(0);
    expect(compareVersions("1.4.10-beta.1", "1.4.10")).toBe(0);
  });
});

describe("classifyVersion", () => {
  const range = { minimum: "2.1.300", testedMaximum: "2.1.302" };

  it("classifies against the accepted range", () => {
    expect(classifyVersion("2.1.299", range)).toBe("tooOld");
    expect(classifyVersion("2.1.300", range)).toBe("supported");
    expect(classifyVersion("2.1.302", range)).toBe("supported");
    expect(classifyVersion("2.2.0", range)).toBe("supported");
  });
});
