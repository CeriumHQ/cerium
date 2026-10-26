import type { ComponentType } from "react";

import type { GlyphProps } from "../settings/glyphs.tsx";
import { hasWords, queryWords, type SearchResult } from "../threads/threadSearch.ts";

/**
 * Something the command palette runs. The window builds the list in `App.tsx` (`paletteCommands`): to
 * offer a new action, add an entry there.
 */
export interface PaletteCommand {
  /** Unique in the list. */
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<GlyphProps>;
  /** Where it's listed: "Actions" are always offered, "Settings" pages only once something is typed. */
  readonly group: "Actions" | "Settings";
  /** The key it already has, as the shortcuts list spells it ("Ctrl Shift 1"). */
  readonly keys?: string;
  /** Other words that find it, besides its label. */
  readonly keywords?: string;
  /** False while it can't run (no thread open, no terminal); it isn't listed then. */
  readonly when?: boolean;
  readonly run: () => void;
}

/** A row of the palette. */
export type PaletteEntry =
  | { readonly kind: "thread"; readonly key: string; readonly result: SearchResult }
  | { readonly kind: "command"; readonly key: string; readonly command: PaletteCommand };

/** A headed section of the palette. */
export interface PaletteGroup {
  /** Its heading. */
  readonly value: string;
  readonly items: ReadonlyArray<PaletteEntry>;
}

/**
 * The commands the words ask for, those named by their label before those found by their keywords. With
 * nothing typed, the actions, which are what the palette teaches the keys of. The `/` list answers
 * the same way, over the actions the message box offers.
 */
export const matchCommands = (
  commands: ReadonlyArray<PaletteCommand>,
  words: ReadonlyArray<string>,
): ReadonlyArray<PaletteCommand> => {
  const listed = commands.filter(({ when }) => when !== false);
  if (words.length === 0) return listed.filter(({ group }) => group === "Actions");
  const named = listed.filter(({ label }) => hasWords(label, words));
  const found = listed.filter(
    (command) => !named.includes(command) && hasWords(`${command.label} ${command.keywords ?? ""}`, words),
  );
  return [...named, ...found];
};

/**
 * What the palette lists: with nothing typed, the latest threads and then the actions (it doubles as a
 * switcher); once something is, the commands that answer it ahead of the threads, since a command
 * names itself in a word or two and a thread is more often found by what was said in it.
 */
export const paletteGroups = (
  threads: ReadonlyArray<SearchResult>,
  commands: ReadonlyArray<PaletteCommand>,
  typed: string,
  threadsHeading: string,
): ReadonlyArray<PaletteGroup> => {
  const words = queryWords(typed);
  const matched = matchCommands(commands, words);
  const commandGroup = (group: PaletteCommand["group"]): PaletteGroup => ({
    value: group,
    items: matched
      .filter((command) => command.group === group)
      .map((command) => ({ kind: "command", key: `command:${command.id}`, command })),
  });
  const threadGroup: PaletteGroup = {
    value: words.length === 0 ? "Recent" : threadsHeading,
    items: threads.map((result) => ({ kind: "thread", key: `thread:${result.thread.id}`, result })),
  };
  const groups =
    words.length === 0
      ? [threadGroup, commandGroup("Actions")]
      : [commandGroup("Actions"), commandGroup("Settings"), threadGroup];
  return groups.filter(({ items }) => items.length > 0);
};
