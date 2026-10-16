import { describe, expect, it } from "@effect/vitest";

import { narrowAccess } from "../src/index.ts";

describe("narrowAccess", () => {
  it("keeps requests at or below the lead's access", () => {
    expect(narrowAccess("acceptEdits", "ask")).toBe("ask");
    expect(narrowAccess("ask", "readOnly")).toBe("readOnly");
    expect(narrowAccess("ask", "ask")).toBe("ask");
  });

  it("caps requests above the lead's access", () => {
    expect(narrowAccess("readOnly", "acceptEdits")).toBe("readOnly");
    expect(narrowAccess("ask", "acceptEdits")).toBe("ask");
  });
});
