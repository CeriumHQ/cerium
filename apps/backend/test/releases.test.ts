import { describe, expect, it } from "@effect/vitest";

import { newerRelease } from "../src/releases.ts";

describe("newerRelease", () => {
  it("names the latest release only when it is newer", () => {
    expect(newerRelease("2.1.306", "2.1.312")).toBe("2.1.312");
    expect(newerRelease("2.1.306", "2.1.306")).toBeUndefined();
    expect(newerRelease("2.1.310", "2.1.306")).toBeUndefined();
    expect(newerRelease("2.1.306", undefined)).toBeUndefined();
  });

  it("names none when either side isn't a version", () => {
    expect(newerRelease("unknown", "2.103.0")).toBeUndefined();
    expect(newerRelease("2.102.1", "nightly")).toBeUndefined();
  });
});
