import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";

import { isShim, macShimFolder, pathHas, shellQuote, shimFor } from "../src/cli.ts";

describe("shimFor", () => {
  it("starts the program detached from a Windows terminal, with the arguments it was given", () => {
    expect(shimFor("win32", "C:\\Apps\\Cerium\\Cerium.exe")).toBe(
      '@echo off\r\nstart "" "C:\\Apps\\Cerium\\Cerium.exe" %*\r\n',
    );
  });

  it("starts it in the background from a Unix shell, quoting the program", () => {
    expect(shimFor("linux", "/opt/Cerium/cerium")).toBe(
      "#!/bin/sh\nnohup '/opt/Cerium/cerium' \"$@\" >/dev/null 2>&1 &\n",
    );
    expect(shimFor("darwin", "/Applications/Cerium.app/Contents/MacOS/Cerium")).toContain(
      "nohup '/Applications/Cerium.app/Contents/MacOS/Cerium' \"$@\"",
    );
  });
});

describe("shellQuote", () => {
  it("keeps everything literal, a quote included", () => {
    expect(shellQuote("/home/it's me/$HOME")).toBe(`'/home/it'\\''s me/$HOME'`);
  });
});

describe("pathHas", () => {
  it("finds a folder in a PATH however it's written", () => {
    const folder = join("C:", "Cerium", "bin");
    expect(pathHas(["C:\\Windows", `${folder}\\`, "C:\\x"].join(";"), folder, ";")).toBe(true);
    expect(pathHas(`"${folder.toLowerCase()}";C:\\x`, folder, ";")).toBe(true);
    expect(pathHas("C:\\Windows;C:\\x", folder, ";")).toBe(false);
    expect(pathHas("", folder, ";")).toBe(false);
  });
});

describe("isShim", () => {
  it("knows Cerium's own shims, for any install, and nothing else", () => {
    expect(isShim("darwin", shimFor("darwin", "/Applications/Cerium.app/Contents/MacOS/Cerium"))).toBe(true);
    expect(isShim("darwin", shimFor("darwin", "/Users/it's me/Cerium.app/Contents/MacOS/Cerium"))).toBe(true);
    expect(isShim("win32", shimFor("win32", "C:\\Apps\\Cerium\\Cerium.exe"))).toBe(true);
    expect(isShim("darwin", "#!/usr/bin/env node\nrequire('cerium')\n")).toBe(false);
  });
});

describe("macShimFolder", () => {
  const home = "/Users/ada";
  const local = "/Users/ada/.local/bin";
  const probe = (shims: Record<string, string>, writable: ReadonlyArray<string>) => ({
    shimIn: async (folder: string) => shims[folder],
    writable: async (folder: string) => writable.includes(folder),
  });
  const brew = ["/opt/homebrew/bin", "/usr/local/bin"];

  it("keeps the folder that already holds Cerium's shim", async () => {
    const shim = shimFor("darwin", "/Applications/Cerium.app/Contents/MacOS/Cerium");
    expect(await macShimFolder("/usr/bin", home, brew, probe({ "/usr/local/bin": shim }, []))).toBe(
      "/usr/local/bin",
    );
  });

  it("takes ~/.local/bin when the shell has it on PATH", async () => {
    expect(await macShimFolder(`/opt/homebrew/bin:${local}:/usr/bin`, home, brew, probe({}, brew))).toBe(
      local,
    );
  });

  it("takes Homebrew's folder when the shell has it and the user can write to it", async () => {
    expect(
      await macShimFolder("/opt/homebrew/bin:/usr/local/bin:/usr/bin", home, brew, probe({}, brew)),
    ).toBe("/opt/homebrew/bin");
    expect(
      await macShimFolder(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
        home,
        brew,
        probe({}, ["/usr/local/bin"]),
      ),
    ).toBe("/usr/local/bin");
  });

  it("never takes the place of another program's cerium", async () => {
    expect(
      await macShimFolder(
        "/opt/homebrew/bin:/usr/bin",
        home,
        brew,
        probe({ "/opt/homebrew/bin": "#!/usr/bin/env node\n" }, brew),
      ),
    ).toBe(local);
  });

  it("falls back to ~/.local/bin when no folder on PATH will do", async () => {
    expect(await macShimFolder("/usr/local/bin:/usr/bin:/bin", home, brew, probe({}, []))).toBe(local);
  });
});
