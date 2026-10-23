import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";

// The models starred in the model menu, kept in this window's local storage like its other preferences.

const FAVORITES_KEY = "cerium:favoriteModels";

const read = (): ReadonlyArray<string> => {
  try {
    const value: unknown = JSON.parse(stored(FAVORITES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
};

/** The starred models' `modelKey`s, in the order starred: the menu's favourites list them so. */
export const favoriteModelsAtom = Atom.writable(read, (context, value: ReadonlyArray<string>) => {
  context.setSelf(value);
  remember(FAVORITES_KEY, JSON.stringify(value));
}).pipe(Atom.keepAlive);

/** `favorites` with `key` starred, or unstarred when it was. */
export const toggleFavorite = (favorites: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
  favorites.includes(key) ? favorites.filter((each) => each !== key) : [...favorites, key];
