import { describe, expect, it } from "@effect/vitest";
import { Settings, SquarePen } from "lucide-react";

import { paletteGroups, paletteOpen, type PaletteCommand } from "../src/features/palette/palette.ts";
import { appearanceCommands, projectCommands } from "../src/features/palette/workspaceCommands.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";
import { searchResults } from "../src/features/threads/threadSearch.ts";

const thread = (id: string, title: string): ThreadSummary => ({
  id,
  title,
  mode: "work",
  project: "cerium",
  folder: "C:/code/cerium",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: 0,
});

describe("workspace commands", () => {
  it("disambiguates project commands by full path when projects share a name", () => {
    const paths = ["/code/app", "/scratch/app"];
    const commands = projectCommands(paths);
    expect(commands.map(({ label, detail }) => [label, detail])).toEqual([
      ["New thread in app", paths[0]],
      ["New thread in app", paths[1]],
    ]);
    expect(new Set(commands.map(({ id }) => id)).size).toBe(2);
    expect(commands.map(({ folder }) => folder)).toEqual(paths);
  });

  it("switches the current appearance, follows system and changes themes independently", () => {
    const appearances: Array<string> = [];
    const themes: Array<string> = [];
    const settings = {
      setTheme: (theme: string) => {
        appearances.push(theme);
      },
      setPalette: (palette: string) => {
        themes.push(palette);
      },
    };
    const dark = appearanceCommands({ ...settings, shown: "dark", desktop: false });
    const light = appearanceCommands({ ...settings, shown: "light", desktop: true });
    dark.find(({ id }) => id === "toggle-appearance")?.run();
    light.find(({ id }) => id === "toggle-appearance")?.run();
    light.find(({ id }) => id === "system-appearance")?.run();
    expect(dark.some(({ id }) => id === "theme:desktop")).toBe(false);
    light.find(({ id }) => id === "theme:desktop")?.run();
    dark.find(({ id }) => id === "theme:midnight")?.run();
    expect(appearances).toEqual(["light", "dark", "system"]);
    expect(themes).toEqual(["desktop", "midnight"]);
  });
});

const command = (id: string, label: string, overrides: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id,
  label,
  group: "Actions",
  icon: SquarePen,
  run: () => undefined,
  ...overrides,
});

const commands = [
  command("new", "New thread", { keys: "Ctrl N" }),
  command("agents", "Show agents", { keywords: "inspector", when: false }),
  command("terminal", "Show terminal", { keywords: "shell" }),
  command("appearance", "Appearance", { group: "Settings", icon: Settings, keywords: "settings" }),
  command("harnesses", "Harnesses", { group: "Settings", keywords: "settings" }),
];

const recent = [{ thread: thread("a", "Fix the build") }];

const shape = (groups: ReturnType<typeof paletteGroups>) =>
  groups.map(({ value, items }) => [
    value,
    items.map((entry) =>
      entry.kind === "thread"
        ? entry.result.thread.id
        : entry.kind === "file"
          ? entry.path
          : entry.command.id,
    ),
  ]);

describe("paletteGroups", () => {
  it("lists the latest threads then the actions when nothing is typed, leaving settings pages out", () => {
    expect(shape(paletteGroups(recent, commands, ""))).toEqual([
      ["Recent", ["a"]],
      ["Actions", ["new", "terminal"]],
    ]);
  });

  it("puts the commands that answer a query ahead of the threads, by label then by keyword", () => {
    expect(shape(paletteGroups([], commands, "shell"))).toEqual([["Actions", ["terminal"]]]);
    expect(shape(paletteGroups([], commands, "settings"))).toEqual([
      ["Settings", ["appearance", "harnesses"]],
    ]);
    expect(shape(paletteGroups(recent, commands, "app"))).toEqual([
      ["Settings", ["appearance"]],
      ["Threads and chats", ["a"]],
    ]);
    expect(shape(paletteGroups(recent, commands, "build"))).toEqual([["Threads and chats", ["a"]]]);
  });

  it("hides a command while it can't run", () => {
    expect(shape(paletteGroups([], commands, "agents"))).toEqual([]);
    expect(shape(paletteGroups([], commands, "inspector"))).toEqual([]);
  });

  it("shows matches across work, chat, active, later and archived threads", () => {
    const passage = [{ text: "Build is red", match: true }];
    const threads = [
      { ...thread("active", "Build agent"), status: "running" as const },
      { ...thread("later", "Build follow-up"), laterUntil: 2000 },
      { ...thread("archived", "Release"), archivedAt: 1000 },
      { ...thread("chat", "Build question"), mode: "chat" as const },
    ];
    const hits = [
      { threadId: "archived", passage },
      { threadId: "chat", passage },
      { threadId: "deleted", passage },
    ];
    const results = searchResults(threads, "build", hits);
    expect(shape(paletteGroups(results, [], "build"))).toEqual([
      ["Threads and chats", ["active", "later", "chat", "archived"]],
    ]);
    expect(results.find((result) => result.thread.id === "chat")?.passage).toBe(passage);
  });

  it("groups files and chosen-project commands, skips folders and caps file matches", () => {
    const project = command("new:cerium", "New thread in Cerium", { group: "Projects" });
    const files = [
      { path: "cerium", folder: true },
      ...Array.from({ length: 14 }, (_, n) => ({ path: `cerium/${n}.ts`, folder: false })),
    ];
    expect(shape(paletteGroups([], [project], "cerium", files))).toEqual([
      ["Projects", ["new:cerium"]],
      ["Files", files.slice(1, 13).map(({ path }) => path)],
    ]);
    expect(paletteGroups([], [project], "", files)).toEqual([]);
  });

  it("uses the platform primary modifier for tab opening and Alt for a split", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    expect(paletteOpen(plain, false)).toBe("default");
    expect(paletteOpen({ ...plain, ctrlKey: true }, false)).toBe("tab");
    expect(paletteOpen({ ...plain, metaKey: true }, true)).toBe("tab");
    expect(paletteOpen({ ...plain, ctrlKey: true }, true)).toBe("default");
    expect(paletteOpen({ ...plain, metaKey: true }, false)).toBe("default");
    expect(paletteOpen({ ...plain, altKey: true }, true)).toBe("split");
  });
});
