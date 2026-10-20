import { describe, expect, it } from "@effect/vitest";
import { Settings, SquarePen } from "lucide-react";

import { paletteGroups, type PaletteCommand } from "../src/features/palette/palette.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";

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
    items.map((entry) => (entry.kind === "thread" ? entry.result.thread.id : entry.command.id)),
  ]);

describe("paletteGroups", () => {
  it("lists the latest threads then the actions when nothing is typed, leaving settings pages out", () => {
    expect(shape(paletteGroups(recent, commands, "", "Threads"))).toEqual([
      ["Recent", ["a"]],
      ["Actions", ["new", "terminal"]],
    ]);
  });

  it("puts the commands that answer a query ahead of the threads, by label then by keyword", () => {
    expect(shape(paletteGroups([], commands, "shell", "Threads"))).toEqual([["Actions", ["terminal"]]]);
    expect(shape(paletteGroups([], commands, "settings", "Threads"))).toEqual([
      ["Settings", ["appearance", "harnesses"]],
    ]);
    expect(shape(paletteGroups(recent, commands, "app", "Chats"))).toEqual([
      ["Settings", ["appearance"]],
      ["Chats", ["a"]],
    ]);
    expect(shape(paletteGroups(recent, commands, "build", "Threads"))).toEqual([["Threads", ["a"]]]);
  });

  it("hides a command while it can't run", () => {
    expect(shape(paletteGroups([], commands, "agents", "Threads"))).toEqual([]);
    expect(shape(paletteGroups([], commands, "inspector", "Threads"))).toEqual([]);
  });
});
