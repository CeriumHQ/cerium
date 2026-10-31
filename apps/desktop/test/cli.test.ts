import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";

import { pathHas, shellQuote, shimFor } from "../src/cli.ts";

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
