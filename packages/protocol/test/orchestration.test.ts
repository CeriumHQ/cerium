import { describe, expect, it } from "@effect/vitest";

import { narrowAccess } from "../src/index.ts";

describe("narrowAccess", () => {
  it("keeps requests at or below the lead's access", () => {
    expect(narrowAccess("acceptEdits", "ask")).toBe("ask");
    expect(narrowAccess("ask", "readOnly")).toBe("readOnly");
    expect(narrowAccess("ask", "ask")).toBe("ask");
    expect(narrowAccess("fullAccess", "acceptEdits")).toBe("acceptEdits");
    expect(narrowAccess("fullAccess", "auto")).toBe("auto");
    expect(narrowAccess("auto", "acceptEdits")).toBe("acceptEdits");
  });

  it("caps requests above the lead's access", () => {
    expect(narrowAccess("readOnly", "acceptEdits")).toBe("readOnly");
    expect(narrowAccess("ask", "acceptEdits")).toBe("ask");
    expect(narrowAccess("acceptEdits", "fullAccess")).toBe("acceptEdits");
    expect(narrowAccess("acceptEdits", "auto")).toBe("acceptEdits");
    expect(narrowAccess("auto", "fullAccess")).toBe("auto");
  });
});
