import { describe, expect, it } from "@effect/vitest";
import { resolve } from "node:path";

import { diskCase, launchArguments, parseLaunch, threadOfLink } from "../src/launch.ts";

const cwd = resolve("/work/app");
const folders = new Set([resolve("/work/app"), resolve("/work/app/src"), resolve("/other")]);
const exists = (path: string) => folders.has(path);

describe("threadOfLink", () => {
  it("reads the thread a link names", () => {
    expect(threadOfLink("cerium://thread/abc-123_X")).toBe("abc-123_X");
    expect(threadOfLink("CERIUM://thread/abc/")).toBe("abc");
  });

  it("refuses anything else", () => {
    expect(threadOfLink("cerium://thread/")).toBeUndefined();
    expect(threadOfLink("cerium://thread/a/b")).toBeUndefined();
    expect(threadOfLink("cerium://settings")).toBeUndefined();
    expect(threadOfLink("https://thread/abc")).toBeUndefined();
    expect(threadOfLink(`cerium://thread/${"a".repeat(101)}`)).toBeUndefined();
  });
});

describe("launchArguments", () => {
  it("drops the program, and in development the app's folder", () => {
    expect(launchArguments(["Cerium.exe", "."], true)).toEqual(["."]);
    expect(launchArguments(["electron.exe", ".", "--dev-url=x", "fix"], false)).toEqual([
      "--dev-url=x",
      "fix",
    ]);
  });

  it("skips a second instance's own flags before the app's folder", () => {
    expect(launchArguments(["electron.exe", "--original-process-start-time=1", "app", "."], false)).toEqual([
      "--original-process-start-time=1",
      ".",
    ]);
  });
});

describe("parseLaunch", () => {
  it("asks for nothing without arguments or with only flags", () => {
    expect(parseLaunch([], cwd, exists)).toBeUndefined();
    expect(parseLaunch(["--hidden", "--dev-url=http://localhost:5173"], cwd, exists)).toBeUndefined();
  });

  it("opens the one folder it names, from where the command ran", () => {
    expect(parseLaunch(["."], cwd, exists)).toEqual({ kind: "folder", folder: cwd });
    expect(parseLaunch(["src"], cwd, exists)).toEqual({ kind: "folder", folder: resolve("/work/app/src") });
    expect(parseLaunch([resolve("/other")], cwd, exists)).toEqual({
      kind: "folder",
      folder: resolve("/other"),
    });
  });

  it("makes a prompt of any other words, in the folder it ran in", () => {
    expect(parseLaunch(["fix login"], cwd, exists)).toEqual({
      kind: "prompt",
      folder: cwd,
      text: "fix login",
    });
    expect(parseLaunch(["fix", "the", "login"], cwd, exists)).toEqual({
      kind: "prompt",
      folder: cwd,
      text: "fix the login",
    });
    // Two words never name a folder, even when the first is one.
    expect(parseLaunch([".", "now"], cwd, exists)).toEqual({ kind: "prompt", folder: cwd, text: ". now" });
  });

  it("leaves flags out of a prompt", () => {
    expect(parseLaunch(["--hidden", "fix login"], cwd, exists)).toEqual({
      kind: "prompt",
      folder: cwd,
      text: "fix login",
    });
  });

  it("opens a link's thread whatever else came with it", () => {
    expect(parseLaunch(["cerium://thread/t1"], cwd, exists)).toEqual({ kind: "thread", id: "t1" });
    expect(parseLaunch(["--x", "cerium://thread/t1"], cwd, exists)).toEqual({ kind: "thread", id: "t1" });
  });

  it("ignores a link that names no thread", () => {
    expect(parseLaunch(["cerium://nothing"], cwd, exists)).toBeUndefined();
  });

  it("cuts a very long prompt", () => {
    const request = parseLaunch(["a".repeat(50_000)], cwd, exists);
    expect(request?.kind === "prompt" && request.text.length).toBe(20_000);
  });
});

describe("diskCase", () => {
  const folders: Record<string, ReadonlyArray<string>> = {
    [resolve("/")]: ["Users"],
    [resolve("/Users")]: ["ada"],
    [resolve("/Users/ada")]: ["Code", "code-old"],
    [resolve("/Users/ada/Code")]: ["App", "app.bak"],
  };
  const list = (folder: string) => {
    const names = folders[folder];
    if (names === undefined) throw new Error("no such folder");
    return names;
  };

  it("spells each part of a folder as the disk lists it", () => {
    expect(diskCase(resolve("/users/ADA/code/app"), list)).toBe(resolve("/Users/ada/Code/App"));
  });

  it("keeps a name the folder lists exactly, and what it can't read as written", () => {
    expect(diskCase(resolve("/Users/ada/code-old"), list)).toBe(resolve("/Users/ada/code-old"));
    expect(diskCase(resolve("/Users/ada/Code/App/src/Lib"), list)).toBe(
      resolve("/Users/ada/Code/App/src/Lib"),
    );
  });

  it("spells the folder a command names, and the one a prompt runs in", () => {
    const spell = (path: string) => diskCase(path, list);
    const exists = () => true;
    expect(parseLaunch(["."], resolve("/users/ada/code/app"), exists, spell)).toEqual({
      kind: "folder",
      folder: resolve("/Users/ada/Code/App"),
    });
    expect(parseLaunch(["fix", "it"], resolve("/users/ada/code/app"), exists, spell)).toMatchObject({
      folder: resolve("/Users/ada/Code/App"),
    });
  });
});
