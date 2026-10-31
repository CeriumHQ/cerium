import { describe, expect, it } from "@effect/vitest";

import { signedWithDeveloperId } from "../src/macUpdates.ts";

describe("signedWithDeveloperId", () => {
  it("takes a Developer ID signature, and nothing signed ad hoc or for development", () => {
    const developerId = [
      "Executable=/Applications/Cerium.app/Contents/MacOS/Cerium",
      "Authority=Developer ID Application: Cerium (ABCDE12345)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=ABCDE12345",
    ].join("\n");
    const adHoc = ["Executable=/Applications/Cerium.app/Contents/MacOS/Cerium", "Signature=adhoc"].join("\n");
    const development = "Authority=Apple Development: someone@example.com (XYZ)";
    expect(signedWithDeveloperId(developerId)).toBe(true);
    expect(signedWithDeveloperId(adHoc)).toBe(false);
    expect(signedWithDeveloperId(development)).toBe(false);
    expect(signedWithDeveloperId("")).toBe(false);
  });
});
