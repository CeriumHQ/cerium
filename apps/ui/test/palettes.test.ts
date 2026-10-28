import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import { desktopPalette, palettes } from "../src/features/settings/palettes.ts";

const themes = readFileSync(new URL("../src/styles/themes.css", import.meta.url), "utf8");

/** The declarations of the block whose selector is exactly `selector`. */
const block = (selector: string) => {
  const start = themes.indexOf(`${selector} {`);
  return start === -1 ? undefined : themes.slice(start, themes.indexOf("}", start));
};

describe("palettes", () => {
  it("have ids of their own", () => {
    expect(new Set(palettes.map((palette) => palette.id)).size).toBe(palettes.length);
  });

  // Cerium is the tokens' own defaults; every other palette tints them and recolours the accent.
  it.each([...palettes.filter((palette) => palette.id !== "cerium"), desktopPalette])(
    "$label sets its tint, and its accent in both modes",
    ({ id }) => {
      expect(block(`[data-palette="${id}"]`)).toContain("--tint-h:");
      for (const mode of ["dark", "light"]) {
        const declarations = block(`[data-palette="${id}"][data-theme="${mode}"]`);
        for (const token of [
          "--tint-c:",
          "--accent:",
          "--accent-strong:",
          "--accent-fg:",
          "--syntax-keyword:",
        ]) {
          expect(declarations, `${id} ${mode} ${token}`).toContain(token);
        }
      }
    },
  );

  it("are all listed for Settings", () => {
    const styled = [...themes.matchAll(/\[data-palette="([\w-]+)"\] \{/g)].map((match) => match[1]);
    expect(new Set(styled)).toEqual(
      new Set([...palettes.map((palette) => palette.id).filter((id) => id !== "cerium"), desktopPalette.id]),
    );
  });
});
