import type { Segment } from "./draft.ts";

// What another app shares to the installed web client: the manifest's `share_target` opens Cerium
// with the shared title, text and link in the address, which become the first message of a new
// thread. The address is cleaned at once, so a reload doesn't bring the same share back.

/** The query parameters the manifest's `share_target` names. */
export const SHARE_PARAMS = { title: "share_title", text: "share_text", url: "share_url" } as const;

export interface Shared {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
}

const clean = (value: string | null): string | undefined => {
  const trimmed = value?.replace(/\r\n?/g, "\n").trim();
  return trimmed ? trimmed : undefined;
};

/** What the address carries of a share; undefined when it carries none. */
export const readShared = (search: string): Shared | undefined => {
  const params = new URLSearchParams(search);
  const title = clean(params.get(SHARE_PARAMS.title));
  const text = clean(params.get(SHARE_PARAMS.text));
  const url = clean(params.get(SHARE_PARAMS.url));
  if (title === undefined && text === undefined && url === undefined) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(text === undefined ? {} : { text }),
    ...(url === undefined ? {} : { url }),
  };
};

/**
 * A share as a message: its title, its text and its link, each once and a blank line apart. Apps put
 * the link in the text as often as in its own field, and the page's title in both title and text.
 */
export const sharedText = ({ title, text, url }: Shared): string => {
  const parts: Array<string> = [];
  const has = (value: string) => parts.some((part) => part.includes(value));
  if (title !== undefined && title !== url && !(text?.includes(title) ?? false)) parts.push(title);
  if (text !== undefined && !has(text)) parts.push(text);
  if (url !== undefined && !has(url)) parts.push(url);
  return parts.join("\n\n");
};

/** A share as a draft's segments. */
export const sharedSegments = (shared: Shared): ReadonlyArray<Segment> => {
  const text = sharedText(shared);
  return text === "" ? [] : [{ kind: "text", text }];
};

/** The address without the share's parameters, keeping any others and the hash. */
export const withoutShare = (href: string): string => {
  const url = new URL(href);
  for (const name of Object.values(SHARE_PARAMS)) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * Takes the share the window opened with, if any: its text for a new thread's first message. The
 * address loses the share's parameters either way, so it's taken once.
 */
export const takeShared = (
  location: Pick<Location, "href" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): string | undefined => {
  const shared = readShared(location.search);
  if (shared === undefined) return undefined;
  history.replaceState(history.state, "", withoutShare(location.href));
  const text = sharedText(shared);
  return text === "" ? undefined : text;
};
