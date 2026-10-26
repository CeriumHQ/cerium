import { describe, expect, it } from "@effect/vitest";

import { guessScripts, scriptsFromToml } from "../src/projectScripts.ts";

// What a project's `.cerium.toml` holds as scripts, and what the guess makes of its package manager.

describe("scriptsFromToml", () => {
  it("reads the project's setup and run", () => {
    expect(scriptsFromToml('[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n')).toEqual({
      setup: "bun install",
      run: "bun run dev",
    });
  });

  it("reads single quotes and drops comments after a command", () => {
    expect(scriptsFromToml("[scripts]\nrun = 'cargo run' # keep it going")).toEqual({ run: "cargo run" });
  });

  it("takes only the top-level scripts section", () => {
    expect(
      scriptsFromToml(
        '[profile.dev]\nrun = "wrong"\n[scripts]\nrun = "right"\n[scripts.more]\nsetup = "wrong"\n',
      ),
    ).toEqual({ run: "right" });
  });

  it("reads a file that Windows wrote with a byte-order mark", () => {
    expect(scriptsFromToml('﻿[scripts]\nsetup = "bun install"\n')).toEqual({ setup: "bun install" });
  });

  it("reads nothing from a file without a scripts section", () => {
    expect(scriptsFromToml('[package]\nname = "x"\nrun = "bun run dev"\n')).toEqual({});
  });
});

describe("guessScripts", () => {
  it("guesses the package manager's install and its dev script", () => {
    expect(guessScripts(["package-lock.json", "package.json"], '{"scripts":{"dev":"vite"}}')).toEqual({
      setup: "npm install",
      run: "npm run dev",
    });
  });

  it("guesses from the package alone when there is no lockfile", () => {
    expect(guessScripts(["package.json"], '{"scripts":{"start":"node ."}}')).toEqual({
      setup: "npm install",
      run: "npm run start",
    });
  });

  it("guesses for python and go projects, which install differently", () => {
    expect(guessScripts(["uv.lock"])).toEqual({ setup: "uv sync" });
    expect(guessScripts(["go.mod"])).toEqual({ setup: "go mod download", run: "go run ." });
  });

  it("guesses nothing for a project none of its kinds fit", () => {
    expect(guessScripts(["README.md"])).toEqual({});
  });
});
