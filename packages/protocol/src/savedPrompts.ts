import { Schema } from "effect";

import { LenientArray } from "./compat.ts";

// A saved prompt: the user's own text, inserted into the message box from the `/` list. Shared by
// the backend, which keeps it with the other settings, and the UI, which shows and edits it.

/** How long a prompt's name may be: a line in the `/` list, not its text. */
export const MAX_PROMPT_NAME = 60;

/** One of the user's saved prompts. `folder` ties it to a project; absent, it works everywhere. */
export const SavedPrompt = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  folder: Schema.optionalKey(Schema.String),
  /** When it was saved, for nothing yet: the list keeps the user's own order. */
  createdAt: Schema.Finite,
});
export type SavedPrompt = typeof SavedPrompt.Type;

/** The saved prompts in the user's order, which the settings page changes. */
export const PromptsSettings = Schema.Struct({
  prompts: LenientArray(SavedPrompt),
});
export type PromptsSettings = typeof PromptsSettings.Type;

/** What a message becomes when saved as a prompt: its first line, cut short. */
export const promptName = (text: string): string => {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const plain = first.trim();
  return plain.length > MAX_PROMPT_NAME ? `${plain.slice(0, MAX_PROMPT_NAME).trimEnd()}…` : plain;
};

/** The prompts that answer in `folder`: the global ones, then its own, each in the user's order. */
export const visiblePrompts = (
  prompts: ReadonlyArray<SavedPrompt>,
  folder: string | undefined,
): ReadonlyArray<SavedPrompt> =>
  prompts.filter((prompt) => prompt.folder === undefined || prompt.folder === folder);

/**
 * The prompts whose name answers `query`, those starting with it first, as the `/` list shows them.
 * With nothing typed, every visible prompt, in the user's order.
 */
export const matchPrompts = (
  prompts: ReadonlyArray<SavedPrompt>,
  query: string,
): ReadonlyArray<SavedPrompt> => {
  const wanted = query.toLowerCase();
  if (wanted === "") return prompts;
  return prompts
    .flatMap((prompt) => {
      const name = prompt.name.toLowerCase();
      const rank = name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : undefined;
      return rank === undefined ? [] : [{ prompt, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.prompt.name.localeCompare(b.prompt.name))
    .map(({ prompt }) => prompt);
};

/** `prompts` with `prompt` saved: a prompt with its id takes its place, a new one joins the end. */
export const withPrompt = (
  prompts: ReadonlyArray<SavedPrompt>,
  prompt: SavedPrompt,
): ReadonlyArray<SavedPrompt> =>
  prompts.some((each) => each.id === prompt.id)
    ? prompts.map((each) => (each.id === prompt.id ? prompt : each))
    : [...prompts, prompt];

/** `prompts` without the prompt `id`. */
export const withoutPrompt = (prompts: ReadonlyArray<SavedPrompt>, id: string): ReadonlyArray<SavedPrompt> =>
  prompts.filter((prompt) => prompt.id !== id);

/**
 * `prompts` with `id` moved one step `toward` the start or end of the list, shifting its neighbour
 * the other way. The list as it was at either end.
 */
export const movePrompt = (
  prompts: ReadonlyArray<SavedPrompt>,
  id: string,
  toward: "up" | "down",
): ReadonlyArray<SavedPrompt> => {
  const from = prompts.findIndex((prompt) => prompt.id === id);
  const to = from + (toward === "up" ? -1 : 1);
  if (from === -1 || to < 0 || to >= prompts.length) return prompts;
  const next = [...prompts];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
};
