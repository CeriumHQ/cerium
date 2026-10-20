// A mode's open threads as tabs, in the order the user keeps them. A tab's key is a thread's id, or
// the key of a thread not started yet. Opening a thread from the sidebar shows it in the strip's
// preview tab, which the next such open replaces, so browsing the list doesn't pile tabs up; the
// preview becomes a kept tab once the user works in it, and a new tab is kept from the start.

export interface TabStrip {
  /** Every open tab, in strip order. */
  readonly keys: ReadonlyArray<string>;
  /** The tab the next preview open replaces. */
  readonly preview?: string;
  /** The tab the strip last showed, which a new tab opens beside. */
  readonly active?: string;
  /** Tabs closed, the latest last, for reopening. */
  readonly closed: ReadonlyArray<string>;
}

export const emptyStrip: TabStrip = { keys: [], closed: [] };

/** How a tab that isn't open yet opens: as the preview, or kept in a tab of its own. */
export type OpenAs = "preview" | "tab";

/** How many closed tabs can be reopened. */
const CLOSED_LIMIT = 20;

const withClosed = (closed: ReadonlyArray<string>, keys: ReadonlyArray<string>) =>
  [...closed.filter((key) => !keys.includes(key)), ...keys].slice(-CLOSED_LIMIT);

const insertAfter = (keys: ReadonlyArray<string>, anchor: string | undefined, key: string) => {
  const at = anchor === undefined ? -1 : keys.indexOf(anchor);
  return at === -1 ? [...keys, key] : [...keys.slice(0, at + 1), key, ...keys.slice(at + 1)];
};

/**
 * `strip` showing `key`. An open tab is simply shown (and kept, when asked for a tab of its own).
 * Otherwise a new tab opens beside the active one; a preview takes the place of the active tab when
 * that one can go without loss (an empty new thread), else of the strip's previous preview.
 */
export const showTab = (
  strip: TabStrip,
  key: string,
  as: OpenAs,
  replaceable: (key: string) => boolean = () => false,
): TabStrip => {
  if (strip.keys.includes(key)) {
    const shown = { ...strip, active: key };
    return as === "tab" ? keepTab(shown, key) : shown;
  }
  if (as === "tab") return { ...strip, keys: insertAfter(strip.keys, strip.active, key), active: key };
  const slot =
    strip.active !== undefined && strip.keys.includes(strip.active) && replaceable(strip.active)
      ? strip.active
      : strip.preview !== undefined && strip.keys.includes(strip.preview)
        ? strip.preview
        : undefined;
  const keys =
    slot === undefined
      ? insertAfter(strip.keys, strip.active, key)
      : strip.keys.map((each) => (each === slot ? key : each));
  return { ...strip, keys, preview: key, active: key };
};

/** `strip` with `key` kept: no longer the preview the next open replaces. */
export const keepTab = (strip: TabStrip, key: string): TabStrip =>
  strip.preview === key
    ? {
        keys: strip.keys,
        ...(strip.active === undefined ? {} : { active: strip.active }),
        closed: strip.closed,
      }
    : strip;

/** `strip` with the tab `from` now `to`, in its place: a new thread that started. */
export const renameTab = (strip: TabStrip, from: string, to: string): TabStrip => {
  const swap = (key: string) => (key === from ? to : key);
  const keys = strip.keys.includes(to) ? strip.keys.filter((key) => key !== from) : strip.keys.map(swap);
  return {
    ...strip,
    keys,
    ...(strip.preview === undefined ? {} : { preview: swap(strip.preview) }),
    ...(strip.active === undefined ? {} : { active: swap(strip.active) }),
    closed: strip.closed.filter((key) => key !== from),
  };
};

/** `strip` with kept tabs for `keys` right after the tab `anchor`, in order; the active tab stays. */
export const openBeside = (strip: TabStrip, anchor: string, keys: ReadonlyArray<string>): TabStrip => {
  const adding = keys.filter((key, index) => key !== anchor && keys.indexOf(key) === index);
  const rest = strip.keys.filter((key) => !adding.includes(key));
  const at = rest.indexOf(anchor);
  return {
    ...strip,
    keys: at === -1 ? [...rest, ...adding] : [...rest.slice(0, at + 1), ...adding, ...rest.slice(at + 1)],
    closed: strip.closed.filter((key) => !adding.includes(key)),
  };
};

/**
 * `strip` without the tabs `keys`, and the tab to show next when the active one was among them:
 * its neighbour on the right, else on the left. None when no tab is left.
 */
export const closeTabs = (
  strip: TabStrip,
  keys: ReadonlyArray<string>,
  { remember = true }: { remember?: boolean } = {},
): { readonly strip: TabStrip; readonly next: string | undefined } => {
  const closing = strip.keys.filter((key) => keys.includes(key));
  if (closing.length === 0) return { strip, next: strip.active };
  const left = strip.keys.filter((key) => !keys.includes(key));
  let next = strip.active;
  if (strip.active === undefined || keys.includes(strip.active)) {
    const at = strip.active === undefined ? -1 : strip.keys.indexOf(strip.active);
    next =
      strip.keys.slice(at + 1).find((key) => !keys.includes(key)) ??
      strip.keys
        .slice(0, Math.max(at, 0))
        .reverse()
        .find((key) => !keys.includes(key));
  }
  const { preview } = strip;
  return {
    strip: {
      keys: left,
      ...(preview === undefined || keys.includes(preview) ? {} : { preview }),
      ...(next === undefined ? {} : { active: next }),
      closed: remember
        ? withClosed(strip.closed, closing)
        : strip.closed.filter((key) => !keys.includes(key)),
    },
    next,
  };
};

/** The tabs a tab's menu closes besides it: every other one, or the ones to its right. */
export const othersOf = (keys: ReadonlyArray<string>, key: string) => keys.filter((each) => each !== key);
export const rightOf = (keys: ReadonlyArray<string>, key: string) => {
  const at = keys.indexOf(key);
  return at === -1 ? [] : keys.slice(at + 1);
};

/** The latest closed tab `canOpen` still allows, and the strip without it in the closed list. */
export const reopenTab = (
  strip: TabStrip,
  canOpen: (key: string) => boolean,
): { readonly strip: TabStrip; readonly key: string | undefined } => {
  const key = strip.closed.findLast((each) => !strip.keys.includes(each) && canOpen(each));
  if (key === undefined) return { strip, key };
  return { strip: { ...strip, closed: strip.closed.filter((each) => each !== key) }, key };
};

/** `strip` with the tab `key` moved to `index` of the strip. */
export const moveTab = (strip: TabStrip, key: string, index: number): TabStrip => {
  const from = strip.keys.indexOf(key);
  if (from === -1) return strip;
  const to = Math.max(0, Math.min(index, strip.keys.length - 1));
  if (from === to) return strip;
  const rest = strip.keys.filter((each) => each !== key);
  return { ...strip, keys: [...rest.slice(0, to), key, ...rest.slice(to)] };
};

/** The tab `step` places from `key` among `keys`, wrapping around the ends. */
export const tabBeside = (keys: ReadonlyArray<string>, key: string | undefined, step: number) => {
  if (keys.length === 0) return undefined;
  const at = key === undefined ? -1 : keys.indexOf(key);
  if (at === -1) return keys[step > 0 ? 0 : keys.length - 1];
  return keys[(((at + step) % keys.length) + keys.length) % keys.length];
};

/** The tab Alt and a digit goes to: the first eight by place, 9 the last, as browsers do. */
export const tabAtDigit = (keys: ReadonlyArray<string>, digit: number) =>
  digit === 9 ? keys.at(-1) : keys[digit - 1];
