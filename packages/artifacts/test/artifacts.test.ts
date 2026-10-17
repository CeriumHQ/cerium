import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";

import { artifactGuide } from "../src/index.ts";

const css = readFileSync(new URL("../src/artifact.css", import.meta.url), "utf8");

describe("artifact guide", () => {
  it("names only classes the stylesheet defines", () => {
    const classes = new Set(
      [...artifactGuide.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/)),
    );
    for (const name of classes) {
      assert.match(css, new RegExp(String.raw`\.${name}(?![\w-])`), `.${name} is not in artifact.css`);
    }
  });

  it("names only tokens and parameters the stylesheet uses", () => {
    const tokens = new Set([...artifactGuide.matchAll(/`(--[a-z0-9-]+)`/g)].map((match) => match[1]!));
    for (const token of tokens) {
      assert.match(css, new RegExp(String.raw`${token}(?![\w-])`), `${token} is not in artifact.css`);
    }
  });
});
