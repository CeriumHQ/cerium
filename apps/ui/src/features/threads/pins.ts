import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";
import type { ThreadSection } from "./sections.ts";
import type { ThreadSummary } from "./model.ts";

const PINS_KEY = "cerium:pinnedThreads";

const readPins = (): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(stored(PINS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/** The ids of the threads the user pinned, most recently pinned first; kept in this window's local storage. */
export const pinnedAtom = Atom.writable(readPins, (context, ids: ReadonlyArray<string>) => {
  context.setSelf(ids);
  remember(PINS_KEY, JSON.stringify(ids));
}).pipe(Atom.keepAlive);

export const togglePin = (pins: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  pins.includes(id) ? pins.filter((pin) => pin !== id) : [id, ...pins];

/**
 * Moves the pinned threads out of their sections into a leading "Pinned" one, in the order they were
 * pinned. A pin whose thread is not in `sections` (archived, deleted, out of scope) is left out.
 */
export const withPinned = (
  sections: ReadonlyArray<ThreadSection>,
  pins: ReadonlyArray<string>,
): ReadonlyArray<ThreadSection> => {
  if (pins.length === 0) return sections;
  const byId = new Map<string, ThreadSummary>();
  for (const section of sections) for (const thread of section.threads) byId.set(thread.id, thread);
  const pinned = pins.flatMap((id) => byId.get(id) ?? []);
  if (pinned.length === 0) return sections;
  const ids = new Set(pinned.map((thread) => thread.id));
  return [
    { key: "pinned", label: "Pinned", kind: "time", threads: pinned },
    ...sections.flatMap((section) => {
      const threads = section.threads.filter((thread) => !ids.has(thread.id));
      return threads.length === 0 ? [] : [{ ...section, threads }];
    }),
  ];
};
