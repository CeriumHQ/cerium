import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editorArgs, findEditors, validLine } from "../src/editors.ts";

describe("editorArgs", () => {
  it("jumps VS Code and Cursor to a line with -g", () => {
    expect(editorArgs("vscode", { file: "/p/a.ts", line: 12 })).toEqual(["-g", "/p/a.ts:12"]);
    expect(editorArgs("vscode", { file: "/p/a.ts" })).toEqual(["-g", "/p/a.ts"]);
    expect(editorArgs("vscode", { file: "/p/a.ts", line: 3, folder: "/p" })).toEqual([
      "/p",
      "-g",
      "/p/a.ts:3",
    ]);
  });

  it("gives Zed the line as a suffix", () => {
    expect(editorArgs("zed", { file: "/p/a.ts", line: 12 })).toEqual(["/p/a.ts:12"]);
  });

  it("gives JetBrains IDEs --line before the file", () => {
    expect(editorArgs("jetbrains", { file: "/p/a.ts", line: 12, folder: "/p" })).toEqual([
      "/p",
      "--line",
      "12",
      "/p/a.ts",
    ]);
    expect(editorArgs("jetbrains", { file: "/p/a.ts" })).toEqual(["/p/a.ts"]);
  });

  it("opens Visual Studio with /Edit and goes to the line once the file is open", () => {
    expect(editorArgs("visualStudio", { file: "C:\\p\\a.cs", line: 7 })).toEqual([
      "/Edit",
      "C:\\p\\a.cs",
      "/Command",
      "Edit.GoTo 7",
    ]);
  });
});

describe("validLine", () => {
  it("takes whole numbers from 1 and nothing else", () => {
    expect(validLine(1)).toBe(1);
    expect(validLine(0)).toBeUndefined();
    expect(validLine(1.5)).toBeUndefined();
    expect(validLine("3")).toBeUndefined();
    expect(validLine(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });
});

describe("findEditors", () => {
  it("finds an editor from where its installer puts it, and one on the PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "cerium-editors-"));
    const code = join(home, "Programs", "Microsoft VS Code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "Code.exe"), "");
    const idea = join(home, "Programs", "IntelliJ IDEA 2026.1", "bin");
    mkdirSync(idea, { recursive: true });
    writeFileSync(join(idea, "idea64.exe"), "");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "zed.exe"), "");

    const found = await findEditors("win32", { LOCALAPPDATA: home, PATH: bin });
    expect(found.map((each) => each.id)).toEqual(["vscode", "zed", "idea"]);
    expect(found[0]?.program).toBe(join(code, "Code.exe"));
  });

  it("finds VS Code from the launcher script on the PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "cerium-editors-"));
    mkdirSync(join(home, "app", "bin"), { recursive: true });
    writeFileSync(join(home, "app", "Code.exe"), "");
    writeFileSync(join(home, "app", "bin", "code.cmd"), "");

    const found = await findEditors("win32", { PATH: join(home, "app", "bin") });
    expect(found.map((each) => each.id)).toEqual(["vscode"]);
  });

  it("finds nothing on a machine with no editors", async () => {
    const home = mkdtempSync(join(tmpdir(), "cerium-editors-"));
    expect(await findEditors("win32", { LOCALAPPDATA: home, PATH: home })).toEqual([]);
  });
});
