// What the What's new panel shows: the entries of CHANGELOG.md bundled with the build, each cut to a
// headline and the detail under it, and which of them this computer hasn't seen yet.

/** What a change did, from the changelog heading it's under. */
export type Kind = "added" | "changed" | "fixed" | "removed" | "other";

export interface Change {
  /** Stays the same while the headline does, so rewording the detail doesn't make it new again. */
  readonly id: string;
  readonly kind: Kind;
  /** The entry's first sentence, markdown. */
  readonly headline: string;
  /** The rest of the entry, markdown; absent when the headline is all of it. */
  readonly detail?: string;
}

const kindOf = (heading: string): Kind => {
  const name = heading.trim().toLowerCase();
  return name === "added" || name === "changed" || name === "fixed" || name === "removed" ? name : "other";
};

/** FNV-1a: short, stable and plenty for a few hundred headlines. */
const hash = (text: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
};

/**
 * An entry's headline and detail: it breaks at the first sentence's end, or at a colon or semicolon
 * after a phrase ("Find in a thread: Ctrl F opens…"), never inside code or brackets. A one-word label before a
 * colon ("UI: …") stays in the headline, and so does "e.g." before a lowercase word.
 */
export const splitEntry = (text: string): { readonly headline: string; readonly detail?: string } => {
  let code = false;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "`") code = !code;
    if (code) continue;
    if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && depth > 0) depth--;
    if (depth > 0 || (char !== "." && char !== ":" && char !== ";")) continue;
    const after = text.slice(index + 1);
    if (after !== "" && !after.startsWith(" ")) continue;
    const rest = after.trim();
    const headline = text.slice(0, index).trim();
    if (char !== "." && (rest === "" || headline.split(/\s+/).length < 2)) continue;
    if (char === "." && /^[a-z]/.test(rest)) continue;
    if (rest === "") return { headline };
    return { headline, detail: rest.charAt(0).toUpperCase() + rest.slice(1) };
  }
  return { headline: text.trim() };
};

/**
 * Every entry of a Keep a Changelog file, in the order the file lists them: each heading takes its
 * newest entries at the top. Continuation lines join their entry; a headline listed twice keeps its
 * first.
 */
export const parseChangelog = (changelog: string): ReadonlyArray<Change> => {
  const entries: Array<{ kind: Kind; text: string }> = [];
  let kind: Kind | undefined;
  for (const line of changelog.split(/\r?\n/)) {
    if (line.startsWith("## ")) kind = undefined;
    else if (line.startsWith("### ")) kind = kindOf(line.slice(4));
    else if (kind !== undefined && line.startsWith("- ")) entries.push({ kind, text: line.slice(2).trim() });
    else if (kind !== undefined && /^\s+\S/.test(line) && entries.length > 0) {
      entries[entries.length - 1]!.text += ` ${line.trim()}`;
    }
  }
  const seen = new Set<string>();
  return entries.flatMap(({ kind: each, text }) => {
    const { headline, detail } = splitEntry(text);
    const id = hash(headline);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, kind: each, headline, ...(detail === undefined ? {} : { detail }) }];
  });
};

/** Where this computer keeps the changes it has shown, as their ids. */
export const SEEN_KEY = "cerium:whatsNewSeen";

export const seenValue = (changes: ReadonlyArray<Change>): string =>
  changes.map((change) => change.id).join(" ");

/**
 * The changes this computer hasn't shown yet. A computer that has never remembered any (a first run)
 * has none: everything in the build is simply how Cerium is.
 */
export const unseenIds = (changes: ReadonlyArray<Change>, seen: string | undefined): ReadonlySet<string> => {
  if (seen === undefined) return new Set();
  const known = new Set(seen.split(" "));
  return new Set(changes.filter((change) => !known.has(change.id)).map((change) => change.id));
};

/** Whether the panel opens by itself: a released build brought changes this computer hasn't seen. */
export const opensAfterUpdate = (unseen: number, version: string): boolean => unseen > 0 && version !== "dev";

/** How many of the earlier changes show at first, and how many more each Show more adds. */
export const EARLIER = 12;
export const MORE = 24;
