import { Atom, type AtomRegistry } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";

// The titles of the pull requests and issues open in tabs, for their tabs to show before the tab has
// read its pull request or issue again. Remembered across launches, a recent few at a time.

const TITLES_KEY = "cerium:githubTitles";

/** How many titles are remembered; the oldest go first. */
const KEPT = 200;

const readTitles = (): ReadonlyMap<string, string> => {
  try {
    const parsed: unknown = JSON.parse(stored(TITLES_KEY) ?? "[]");
    return new Map(
      Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
          )
        : [],
    );
  } catch {
    return new Map();
  }
};

/** Each GitHub tab's title, by its tab key (see `githubKey`). */
export const githubTitlesAtom = Atom.make<ReadonlyMap<string, string>>(readTitles()).pipe(Atom.keepAlive);

/** Names a GitHub tab, as its pull request or issue is called now. */
export const nameGitHubTab = (registry: AtomRegistry.AtomRegistry, key: string, title: string) =>
  registry.update(githubTitlesAtom, (titles) => {
    if (titles.get(key) === title) return titles;
    const next = new Map(titles);
    next.delete(key);
    next.set(key, title);
    const kept = [...next].slice(-KEPT);
    remember(TITLES_KEY, JSON.stringify(kept));
    return new Map(kept);
  });
