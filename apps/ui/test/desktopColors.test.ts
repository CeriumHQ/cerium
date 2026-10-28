import { describe, expect, it } from "@effect/vitest";

import { asDesktopColors, desktopProperties, statusTurn } from "../src/features/settings/desktopColors.ts";

const blue = { l: 0.57, c: 0.17, h: 251 };
const field = { l: 0.6, c: 0.05, h: 140 };

describe("asDesktopColors", () => {
  it("keeps what the shell sent", () => {
    expect(
      asDesktopColors({ accent: blue, wallpaper: field, thumbnail: "data:image/jpeg;base64,AA" }),
    ).toEqual({
      accent: blue,
      wallpaper: field,
      thumbnail: "data:image/jpeg;base64,AA",
    });
  });

  it("names no colours for nothing, or for colours that aren't numbers", () => {
    expect(asDesktopColors({})).toBeUndefined();
    expect(asDesktopColors({ accent: { l: "1", c: 0, h: 0 } })).toBeUndefined();
    expect(asDesktopColors(null)).toBeUndefined();
  });

  it("drops a thumbnail that isn't an image", () => {
    expect(
      asDesktopColors({ accent: blue, thumbnail: "https://example.com/a.jpg" })?.thumbnail,
    ).toBeUndefined();
  });
});

describe("statusTurn", () => {
  it("turns a status the accent would be mistaken for", () => {
    // Windows' blue accent pushes "running" (245) away, towards cyan.
    expect(245 + statusTurn(245, blue)).toBeCloseTo(blue.h - 35);
    // Across 0°: a red accent at 5° pushes "error" (25) round to 40°.
    expect(25 + statusTurn(25, { l: 0.6, c: 0.2, h: 5 })).toBeCloseTo(40);
    expect(25 + statusTurn(25, { l: 0.6, c: 0.2, h: 355 })).toBeCloseTo(30);
  });

  it("leaves a status far enough from the accent, or beside a grey one", () => {
    expect(statusTurn(152, blue)).toBe(0);
    expect(statusTurn(245, { ...blue, c: 0.01 })).toBe(0);
  });
});

describe("desktopProperties", () => {
  it("tints the glass with the wallpaper and the accent with the accent", () => {
    const properties = desktopProperties({ accent: blue, wallpaper: field });
    expect(properties["--desktop-tint-h"]).toBe("140");
    expect(properties["--desktop-tint-c"]).toBe("0.05");
    expect(properties["--desktop-accent-h"]).toBe("251");
    expect(properties["--desktop-running-turn"]).toBe("-29");
    expect(properties["--desktop-success-turn"]).toBe("0");
  });

  it("lets either colour stand in for the other", () => {
    expect(desktopProperties({ wallpaper: field })["--desktop-accent-h"]).toBe("140");
    const accentOnly = desktopProperties({ accent: blue });
    expect(accentOnly["--desktop-tint-h"]).toBe("251");
    expect(accentOnly["--desktop-tint-c"]).toBe(String(Number((blue.c * 0.25).toFixed(4))));
  });
});
