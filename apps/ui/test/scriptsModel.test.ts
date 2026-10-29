import type { ProjectScripts } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  actionsSaved,
  alreadyInFile,
  changed,
  commandsOf,
  initialProject,
  rowProblems,
  rowsOf,
  savedActions,
  savedWord,
  type CardState,
} from "../src/features/settings/scriptsModel.ts";

// How the Project scripts card turns what's typed into what's saved on this machine or written to the
// project's file, and which project it opens on.

const fromFile: ProjectScripts = {
  setup: { text: "bun install", from: "project" },
  run: { text: "bun run dev", from: "guessed" },
  actions: [{ name: "Test", text: "bun test", from: "project" }],
};

const stateOf = (scripts: ProjectScripts, edit: Partial<CardState> = {}): CardState => ({
  texts: { setup: scripts.setup?.text ?? "", run: scripts.run?.text ?? "" },
  rows: rowsOf(scripts),
  ...edit,
});

describe("savedWord", () => {
  it("defers a command left as the file or the guess offered it", () => {
    expect(savedWord(fromFile, "setup", "bun install")).toBeNull();
    expect(savedWord(fromFile, "run", "bun run dev")).toBeNull();
  });

  it("keeps a changed command, and one that is already the user's", () => {
    expect(savedWord(fromFile, "setup", "pnpm install")).toBe("pnpm install");
    expect(savedWord({ run: { text: "x", from: "saved" } }, "run", "x")).toBe("x");
  });

  it("turns a command off when its field is emptied, and keeps a field nothing offered", () => {
    expect(savedWord(fromFile, "setup", "")).toBe("");
    expect(savedWord({}, "run", "")).toBe("");
    expect(savedWord({}, "run", "make")).toBe("make");
  });
});

describe("rowProblems", () => {
  const row = (id: number, name: string, command: string) => ({ id, name, command });

  it("ignores rows left blank and finds nothing wrong with a name and a command", () => {
    expect(rowProblems([row(1, "Test", "bun test"), row(2, "", " ")]).size).toBe(0);
  });

  it("asks for what's missing, and for names that can't be told apart", () => {
    const problems = rowProblems([
      row(1, "Test", "bun test"),
      row(2, "", "x"),
      row(3, "Lint", ""),
      row(4, "test", "y"),
      row(5, "Run", "z"),
    ]);
    expect(problems.get(1)).toBeUndefined();
    expect(problems.get(2)).toBe("Give it a name.");
    expect(problems.get(3)).toBe("Add a command.");
    expect(problems.get(4)).toBe("That name is taken.");
    expect(problems.get(5)).toMatch(/script of its own/);
  });
});

describe("savedActions", () => {
  it("defers a list left as the file has it", () => {
    expect(savedActions(fromFile, rowsOf(fromFile))).toBeNull();
  });

  it("saves the list once it differs, an empty one turning the file's actions off", () => {
    const edited = [{ id: 0, name: "Test", command: "bun run test" }];
    expect(savedActions(fromFile, edited)).toEqual([{ name: "Test", command: "bun run test" }]);
    expect(savedActions(fromFile, [])).toEqual([]);
  });

  it("keeps saving a list that is already the user's, even an empty one", () => {
    const own: ProjectScripts = { actions: [{ name: "Test", text: "bun test", from: "saved" }] };
    expect(actionsSaved(own)).toBe(true);
    expect(savedActions(own, rowsOf(own))).toEqual([{ name: "Test", command: "bun test" }]);
    expect(actionsSaved({ actions: [] })).toBe(true);
    expect(savedActions({ actions: [] }, [])).toEqual([]);
  });

  it("saves nothing for a project with no actions anywhere, and drops the rows left blank", () => {
    expect(savedActions({}, [])).toBeNull();
    expect(savedActions({}, [{ id: 1, name: " ", command: "" }])).toBeNull();
    expect(commandsOf([{ id: 1, name: " Lint ", command: " bun run lint " }])).toEqual([
      { name: "Lint", command: "bun run lint" },
    ]);
  });
});

describe("changed and alreadyInFile", () => {
  it("see an untouched card as unchanged", () => {
    expect(changed(fromFile, stateOf(fromFile))).toBe(false);
  });

  it("see an edited command or action as a change", () => {
    expect(changed(fromFile, stateOf(fromFile, { texts: { setup: "bun ci", run: "bun run dev" } }))).toBe(
      true,
    );
    expect(changed(fromFile, stateOf(fromFile, { rows: [] }))).toBe(true);
  });

  it("say what's all the file's already needs no writing, and a guess or a saved word does", () => {
    const allFile: ProjectScripts = {
      setup: { text: "a", from: "project" },
      actions: [{ name: "T", text: "t", from: "project" }],
    };
    expect(alreadyInFile(allFile, stateOf(allFile))).toBe(true);
    expect(alreadyInFile(fromFile, stateOf(fromFile))).toBe(false);
    expect(
      alreadyInFile(
        { setup: { text: "a", from: "saved" } },
        stateOf({ setup: { text: "a", from: "saved" } }),
      ),
    ).toBe(false);
    expect(alreadyInFile(allFile, stateOf(allFile, { rows: [] }))).toBe(false);
  });
});

describe("initialProject", () => {
  const projects = ["C:\\Work\\api", "C:\\Work\\site"];

  it("opens on the project the user came from, however its path is spelled", () => {
    expect(initialProject(projects, "c:/work/site/")).toBe("C:\\Work\\site");
  });

  it("opens on the first project when it came from none the machine knows", () => {
    expect(initialProject(projects, "C:\\Elsewhere")).toBe("C:\\Work\\api");
    expect(initialProject(projects, undefined)).toBe("C:\\Work\\api");
    expect(initialProject([], "C:\\Work\\api")).toBeUndefined();
  });
});
