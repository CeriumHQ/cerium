import type { ThreadId } from "@cerium/protocol";
import type { TerminalId, TerminalInfo } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  DRAWER,
  drawerLayout,
  exitNote,
  inputPieces,
  shownTerminal,
  tabLabels,
  terminalsOf,
} from "../src/features/terminal/model.ts";

const terminal = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: id as TerminalId,
  threadId: "thr_a" as ThreadId,
  shell: "PowerShell",
  cwd: "C:\\work",
  openedAt: 1,
  run: 1,
  ...extra,
});

describe("drawerLayout", () => {
  it("keeps the saved height while it fits", () => {
    expect(drawerLayout(900, 300)).toEqual({ height: 300, max: 660 });
  });

  it("leaves the conversation its room in a short column", () => {
    expect(drawerLayout(500, 400)).toEqual({ height: 260, max: 260 });
  });

  it("never goes below its least height", () => {
    expect(drawerLayout(900, 40).height).toBe(DRAWER.min);
    expect(drawerLayout(200, 400)).toEqual({ height: DRAWER.min, max: DRAWER.min });
  });
});

describe("terminalsOf", () => {
  it("lists a thread's terminals in the order they opened", () => {
    const all = [
      terminal("b", { openedAt: 3 }),
      terminal("other", { threadId: "thr_b" as ThreadId }),
      terminal("a", { openedAt: 2 }),
    ];
    expect(terminalsOf(all, { threadId: "thr_a" }).map((each) => each.id)).toEqual(["a", "b"]);
  });

  it("lists a project's own terminals, not its threads'", () => {
    const projectTerminal = (id: string, project: string): TerminalInfo => {
      const { threadId: _, ...rest } = terminal(id);
      return { ...rest, project };
    };
    const all = [
      projectTerminal("p", "C:\\work"),
      terminal("thread", { cwd: "C:\\work" }),
      projectTerminal("elsewhere", "C:\\other"),
    ];
    expect(terminalsOf(all, { project: "C:\\work" }).map((each) => each.id)).toEqual(["p"]);
  });
});

describe("tabLabels", () => {
  it("numbers only shells a thread has more than one of", () => {
    const labels = tabLabels([terminal("a"), terminal("b", { shell: "Command Prompt" }), terminal("c")]);
    expect(labels).toEqual(["PowerShell 1", "Command Prompt", "PowerShell 2"]);
  });
});

describe("shownTerminal", () => {
  const terminals = [terminal("a"), terminal("b")];

  it("shows the one the thread last showed", () => {
    expect(shownTerminal(terminals, "a")?.id).toBe("a");
  });

  it("falls back to the newest once that one is gone", () => {
    expect(shownTerminal(terminals, "gone")?.id).toBe("b");
    expect(shownTerminal(terminals, undefined)?.id).toBe("b");
    expect(shownTerminal([], "a")).toBeUndefined();
  });
});

describe("exitNote", () => {
  it("says how the shell ended", () => {
    expect(exitNote(0)).toBe("Exited");
    expect(exitNote(undefined)).toBe("Exited");
    expect(exitNote(2)).toBe("Exited with code 2");
  });

  it("writes Windows' status codes in hex", () => {
    expect(exitNote(-1073741510)).toBe("Exited with code 0xC000013A");
    expect(exitNote(259)).toBe("Exited with code 0x103");
  });
});

describe("inputPieces", () => {
  it("splits a long paste into pieces of at most the given length", () => {
    expect(inputPieces("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(inputPieces("", 3)).toEqual([]);
  });

  it("never splits a character that takes two", () => {
    const pieces = inputPieces("ab😀cd", 3);
    expect(pieces).toEqual(["ab", "😀c", "d"]);
    expect(pieces.join("")).toBe("ab😀cd");
  });
});
