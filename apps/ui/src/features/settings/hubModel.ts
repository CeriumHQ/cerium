import type { HubHarness, HubScope, HubServer, HubSkill, ProviderId } from "@cerium/protocol";

// The hub pages list a server or skill once, however many harnesses configure it: grouped by name, with
// each harness's own copy inside. Pure, so the pages' grouping and search are tested on their own.

/** Where the hub sorts a group: this project's own, every project's, or the harness's built-in ones. */
export type HubPlace = "project" | "user" | "bundled";

/** One harness's copy of a server or skill. */
export interface HubEntry<T> {
  readonly harness: HubHarness;
  readonly item: T;
}

/** A server or skill by name, with every harness's copy of it. */
export interface HubGroup<T> {
  readonly key: string;
  readonly name: string;
  readonly place: HubPlace;
  readonly entries: ReadonlyArray<HubEntry<T>>;
}

const placeOf = (scope: HubScope): HubPlace => (scope === "local" ? "project" : scope);

const placeRank: Record<HubPlace, number> = { project: 0, user: 1, bundled: 2 };

/**
 * Every harness's servers or skills, one group per name (case aside), each placed where its most local
 * copy is, and sorted by place, then name.
 */
export function groupHub<T extends { readonly name: string; readonly scope: HubScope }>(
  harnesses: ReadonlyArray<HubHarness>,
  items: (harness: HubHarness) => ReadonlyArray<T>,
): ReadonlyArray<HubGroup<T>> {
  const groups = new Map<string, Array<HubEntry<T>>>();
  for (const harness of harnesses) {
    for (const item of items(harness)) {
      const key = item.name.toLowerCase();
      const entries = groups.get(key) ?? [];
      entries.push({ harness, item });
      groups.set(key, entries);
    }
  }
  return [...groups]
    .map(([key, entries]): HubGroup<T> => {
      const place = entries
        .map((entry) => placeOf(entry.item.scope))
        .reduce((best, each) => (placeRank[each] < placeRank[best] ? each : best));
      return { key, name: entries[0]?.item.name ?? key, place, entries };
    })
    .toSorted((a, b) => placeRank[a.place] - placeRank[b.place] || a.name.localeCompare(b.name));
}

/** What a server runs, in full: its URL, or its command and arguments. */
export const serverLine = (server: HubServer) =>
  server.url ?? [server.command ?? "", ...(server.args ?? [])].join(" ").trim();

/** An absolute path's file name, as `C:\…\server.exe` is `server.exe`; anything else as it is. */
const fileName = (word: string) =>
  /^([A-Za-z]:)?[\\/]/.test(word) ? (word.split(/[\\/]/).findLast((part) => part !== "") ?? word) : word;

/** What a server's row says it runs, short: its URL, or its command and arguments with paths cut to file names. */
export const serverGist = (server: HubServer) =>
  server.url ?? [server.command ?? "", ...(server.args ?? [])].map(fileName).join(" ").trim();

/** The text a search looks through: a server's name and what it runs, a skill's name and description. */
const searchable = (item: HubServer | HubSkill) =>
  "transport" in item ? `${item.name} ${serverLine(item)}` : `${item.name} ${item.description ?? ""}`;

/** The groups the search and the harness picked keep: all of them for an empty search and no harness. */
export function filterHub<T extends HubServer | HubSkill>(
  groups: ReadonlyArray<HubGroup<T>>,
  { query, provider }: { query: string; provider: ProviderId | undefined },
): ReadonlyArray<HubGroup<T>> {
  const needle = query.trim().toLowerCase();
  return groups.filter(
    (group) =>
      (provider === undefined || group.entries.some((entry) => entry.harness.provider === provider)) &&
      (needle === "" || group.entries.some((entry) => searchable(entry.item).toLowerCase().includes(needle))),
  );
}
