import type { PromptsSettings, SavedPrompt } from "@cerium/protocol";
import { movePrompt, withPrompt, withoutPrompt } from "@cerium/protocol";

import { baseName } from "../../components/fileIcons/index.ts";
import { useSetting } from "../settings/useSetting.ts";

// The user's saved prompts, kept with the backend's settings: global ones, and ones tied to the
// project (folder) they were saved in. The `/` list inserts them; Settings → Prompts manages them;
// a user message's menu saves one.

/** What the list shows a prompt's scope as; global ones need no marking. */
export const scopeLabel = (prompt: SavedPrompt): string | undefined =>
  prompt.folder === undefined ? undefined : baseName(prompt.folder);

/**
 * One of the settings the backend applies. `savePrompt` adds a new prompt to the end of the list,
 * `replacePrompt` keeps an edited one where it was, and `movePrompt` steps one toward either end.
 */
export function usePrompts() {
  const { value, saved, save, error } = useSetting("prompts", { prompts: [] });
  const prompts = value.prompts;
  const change = (next: ReadonlyArray<SavedPrompt>) => save({ prompts: next });
  return {
    prompts,
    /** The setting can't change before the backend has answered. */
    disabled: saved === undefined,
    error,
    savePrompt: (prompt: SavedPrompt) => change(withPrompt(prompts, prompt)),
    removePrompt: (id: string) => change(withoutPrompt(prompts, id)),
    movePrompt: (id: string, toward: "up" | "down") => change(movePrompt(prompts, id, toward)),
  } as const;
}

/** A prompt as `savePrompt` keeps it: an id and date of its own, in the caller's scope. */
export const newPrompt = ({
  name,
  text,
  folder,
}: {
  readonly name: string;
  readonly text: string;
  readonly folder?: string | undefined;
}): SavedPrompt => ({
  id: crypto.randomUUID(),
  name: name.trim(),
  text,
  ...(folder === undefined ? {} : { folder }),
  createdAt: Date.now(),
});

export type { PromptsSettings, SavedPrompt };
