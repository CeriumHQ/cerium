import { describe, expect, it } from "@effect/vitest";

import {
  chooseShell,
  exitCodeOf,
  shellName,
  taskkillArgs,
  terminalEnv,
  windowsBuild,
  type ShellHost,
} from "../src/terminalShell.ts";

const host = (
  platform: NodeJS.Platform,
  env: Record<string, string>,
  files: ReadonlyArray<string>,
): ShellHost => ({ platform, env, exists: (file) => files.includes(file) });

describe("chooseShell", () => {
  it("prefers PowerShell 7 on PATH", () => {
    const shell = chooseShell(
      host("win32", { PATH: "C:\\Windows;C:\\Tools\\PowerShell" }, [
        "C:\\Tools\\PowerShell\\pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]),
    );
    expect(shell).toEqual({ file: "C:\\Tools\\PowerShell\\pwsh.exe", args: ["-NoLogo"], name: "PowerShell" });
  });

  it("finds PowerShell 7 in Program Files when PATH misses it", () => {
    const shell = chooseShell(
      host("win32", { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" }, [
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ]),
    );
    expect(shell.file).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to Windows PowerShell, then the command prompt", () => {
    const withPowerShell = chooseShell(
      host("win32", { SystemRoot: "C:\\Windows", PATH: "" }, [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]),
    );
    expect(withPowerShell).toEqual({
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
      name: "Windows PowerShell",
    });
    const bare = chooseShell(host("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "" }, []));
    expect(bare).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: [], name: "Command Prompt" });
  });

  it("uses the user's $SHELL elsewhere, and starts a Mac's shell as a login shell", () => {
    expect(chooseShell(host("linux", { SHELL: "/usr/bin/fish" }, ["/usr/bin/fish"]))).toEqual({
      file: "/usr/bin/fish",
      args: [],
      name: "fish",
    });
    expect(chooseShell(host("darwin", { SHELL: "/bin/zsh" }, ["/bin/zsh"])).args).toEqual(["-l"]);
  });

  it("falls back to a shell that is there when $SHELL is missing or gone", () => {
    expect(chooseShell(host("linux", { SHELL: "/gone/shell" }, ["/bin/bash"])).file).toBe("/bin/bash");
    expect(chooseShell(host("linux", {}, [])).file).toBe("/bin/sh");
    expect(chooseShell(host("darwin", {}, ["/bin/zsh", "/bin/bash"])).file).toBe("/bin/zsh");
  });
});

describe("shellName", () => {
  it("names shells as a tab shows them", () => {
    expect(shellName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("PowerShell");
    expect(shellName("C:\\Windows\\System32\\cmd.exe")).toBe("Command Prompt");
    expect(shellName("/usr/local/bin/zsh")).toBe("zsh");
  });
});

describe("terminalEnv", () => {
  it("sets up a terminal emulator and keeps Electron's switches from reaching the shell", () => {
    const env = terminalEnv(
      { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", GONE: undefined, TERM: "dumb" },
      "1.2.3",
    );
    expect(env).toEqual({
      PATH: "/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Cerium",
      TERM_PROGRAM_VERSION: "1.2.3",
    });
  });
});

describe("exitCodeOf", () => {
  it("reports a code as is and a signal as shells do", () => {
    expect(exitCodeOf({ exitCode: 3 })).toBe(3);
    expect(exitCodeOf({ exitCode: 0, signal: 0 })).toBe(0);
    expect(exitCodeOf({ exitCode: 0, signal: 9 })).toBe(137);
  });
});

describe("taskkillArgs", () => {
  it("ends the whole process tree", () => {
    expect(taskkillArgs(4242)).toEqual(["/pid", "4242", "/T", "/F"]);
  });
});

describe("windowsBuild", () => {
  it("reads the build from the release, on Windows only", () => {
    expect(windowsBuild("win32", "10.0.26300")).toBe(26300);
    expect(windowsBuild("linux", "6.8.0")).toBeUndefined();
    expect(windowsBuild("win32", "weird")).toBeUndefined();
  });
});
