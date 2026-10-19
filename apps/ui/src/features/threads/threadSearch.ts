import type { ThreadSummary } from "./model.ts";

// What the thread search shows: threads whose title (or project) has a word starting with each word
// typed, at once, then the threads whose messages do, as the backend finds them.

/** The `RPC_VERSION` that brought `SearchThreads`; an older machine can only be searched by title. */
export const THREAD_SEARCH_VERSION = 2;

/** How many recent threads the search offers before anything is typed. */
const RECENT = 8;

/** How few characters the backend is asked about: one letter matches too much to be worth the wait. */
export const MIN_MESSAGE_QUERY = 2;

/** A stretch of text, marked when it's what was searched for. */
export interface Piece {
  readonly text: string;
  readonly match: boolean;
}

/** A thread found, with the passage of its messages that matched when they did. */
export interface SearchResult {
  readonly thread: ThreadSummary;
  readonly passage?: ReadonlyArray<Piece>;
}

/** A thread the backend found in its messages. */
export interface MessageHit {
  readonly threadId: string;
  readonly passage: ReadonlyArray<Piece>;
}

/** Lower case without accents, so "cafe" finds "Café". Falls back to plain lower case to keep lengths. */
const fold = (text: string): string => {
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  return folded.length === text.length ? folded : text.toLocaleLowerCase();
};

/** The words typed, folded; empty while nothing but spaces is. */
export const queryWords = (typed: string): ReadonlyArray<string> =>
  fold(typed)
    .split(/\s+/u)
    .filter((word) => word !== "");

/** Where `word` starts a word of `folded`, as the message search does: "dat" finds "data", not "updated". */
const startsOf = (folded: string, word: string): ReadonlyArray<number> => {
  const at: Array<number> = [];
  for (let from = folded.indexOf(word); from !== -1; from = folded.indexOf(word, from + 1)) {
    if (from === 0 || !/[\p{L}\p{N}]/u.test(folded.charAt(from - 1))) at.push(from);
  }
  return at;
};

/** `text` cut into plain and matched pieces, wherever a word of `words` starts a word in it. */
export const highlight = (text: string, words: ReadonlyArray<string>): ReadonlyArray<Piece> => {
  const folded = fold(text);
  if (folded.length !== text.length || words.length === 0) return [{ text, match: false }];
  const ranges: Array<[number, number]> = words.flatMap((word) =>
    startsOf(folded, word).map((at): [number, number] => [at, at + word.length]),
  );
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const pieces: Array<Piece> = [];
  let from = 0;
  for (const [start, end] of merged) {
    if (start > from) pieces.push({ text: text.slice(from, start), match: false });
    pieces.push({ text: text.slice(start, end), match: true });
    from = end;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), match: false });
  return pieces.length === 0 ? [{ text, match: false }] : pieces;
};

/**
 * How well a thread's title (and project) answer the words: 0 when the title starts with the first,
 * 1 when each starts a word of it, 2 when the project's name answers for some; -1 for no match.
 */
const titleRank = (thread: ThreadSummary, words: ReadonlyArray<string>): number => {
  const title = fold(thread.title);
  const inTitle = (word: string) => startsOf(title, word).length > 0;
  if (words.every(inTitle)) return startsOf(title, words[0]!)[0] === 0 ? 0 : 1;
  const project = fold(thread.project ?? "");
  return words.every((word) => inTitle(word) || startsOf(project, word).length > 0) ? 2 : -1;
};

/**
 * What the search lists for what was typed: threads whose title or project starts a word with each, best
 * first and newest first among equals, then threads found only in their messages in the order the
 * backend ranked them. With nothing typed, the latest threads, so the search doubles as a switcher.
 * `threads` are one mode's, archived ones too; archived threads are searched but never suggested.
 */
export const searchResults = (
  threads: ReadonlyArray<ThreadSummary>,
  typed: string,
  hits: ReadonlyArray<MessageHit> = [],
): ReadonlyArray<SearchResult> => {
  const words = queryWords(typed);
  if (words.length === 0) {
    return threads
      .filter((thread) => thread.archivedAt === undefined || thread.status === "awaitingApproval")
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT)
      .map((thread) => ({ thread }));
  }
  const passages = new Map(hits.map((hit) => [hit.threadId, hit.passage]));
  const byTitle = threads
    .map((thread) => ({ thread, rank: titleRank(thread, words) }))
    .filter(({ rank }) => rank >= 0)
    .toSorted((a, b) => a.rank - b.rank || b.thread.updatedAt - a.thread.updatedAt);
  const named = new Set(byTitle.map(({ thread }) => thread.id));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return [
    ...byTitle.map(({ thread }): SearchResult => {
      const passage = passages.get(thread.id);
      return passage === undefined ? { thread } : { thread, passage };
    }),
    ...hits.flatMap(({ threadId, passage }): ReadonlyArray<SearchResult> => {
      const thread = byId.get(threadId);
      return thread === undefined || named.has(threadId) ? [] : [{ thread, passage }];
    }),
  ];
};
