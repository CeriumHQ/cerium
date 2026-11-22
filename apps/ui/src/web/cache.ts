import { AccountThreads, type AccountState } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { useEffect, useEffectEvent } from "react";

// The web client's last look at the account's threads, kept in the browser's storage for the relay's
// origin, so the Home Screen app shows them the moment it opens while its relay connection and the
// tunnel to the machine it drives come up behind them. Only ever a stand-in: the relay's word
// replaces it as soon as it arrives, and signing out forgets it.

const CACHE_KEY = "cerium:account-threads";

/** How many of the most recently active threads are kept: browser storage holds a few megabytes. */
export const THREADS_KEPT = 200;

/** How long after a change the copy is written: threads change with every turn an agent takes. */
const SAVE_AFTER_MS = 1_000;

const Device = Schema.Struct({ id: Schema.String, name: Schema.String });

const Cached = Schema.fromJsonString(
  Schema.Struct({
    /** The account the threads are of: another account signing in on this browser never sees them. */
    account: Schema.String,
    savedAt: Schema.Finite,
    threads: AccountThreads,
    /** The account's computers' names, which the relay lists only once it's connected. */
    devices: Schema.Array(Device),
  }),
);
export type CachedThreads = typeof Cached.Type;

const decode = Schema.decodeUnknownOption(Cached);
const encode = Schema.encodeOption(Cached);

/** The `kept` most recently active threads, and what was seen of those. */
export const newestThreads = (threads: AccountThreads, kept = THREADS_KEPT): AccountThreads => {
  if (threads.threads.length <= kept) return threads;
  const newest = threads.threads
    .toSorted((a, b) => b.overview.thread.updatedAt - a.overview.thread.updatedAt)
    .slice(0, kept);
  const ids = new Set<string>(newest.map((each) => each.overview.thread.id));
  return { threads: newest, read: threads.read.filter((entry) => ids.has(entry.threadId)) };
};

/** The copy as text, or none when it can't be written down. */
export const encodeCached = (cached: CachedThreads): string | undefined =>
  Option.getOrUndefined(encode({ ...cached, threads: newestThreads(cached.threads) }));

/** The copy from its text, or none when it's missing, or from a build that wrote it another way. */
export const decodeCached = (text: string | null | undefined): CachedThreads | undefined =>
  text == null ? undefined : Option.getOrUndefined(decode(text));

/** The kept copy, whichever account it's of; none when there isn't one or storage is blocked. */
export const cachedThreads = (): CachedThreads | undefined => {
  try {
    return decodeCached(localStorage.getItem(CACHE_KEY));
  } catch {
    return undefined;
  }
};

/** The kept copy, when it's of `account`. */
export const cachedThreadsOf = (cached: CachedThreads | undefined, account: AccountState) =>
  cached !== undefined && account._tag === "SignedIn" && account.account.id === cached.account
    ? cached
    : undefined;

/** Whether there is a copy to show at once: the launch screen needn't wait for the relay. */
export const hasCachedThreads = () => {
  try {
    return localStorage.getItem(CACHE_KEY) !== null;
  } catch {
    return false;
  }
};

const save = (cached: CachedThreads) => {
  const text = encodeCached(cached);
  if (text === undefined) return;
  try {
    localStorage.setItem(CACHE_KEY, text);
  } catch {
    // Full: half as many threads, once, else none kept this time.
    try {
      const fewer = encodeCached({ ...cached, threads: newestThreads(cached.threads, THREADS_KEPT / 2) });
      if (fewer !== undefined) localStorage.setItem(CACHE_KEY, fewer);
    } catch {
      // The copy is a convenience only.
    }
  }
};

/** Forgets the copy, as signing out does. */
export const forgetCachedThreads = () => {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing kept to forget.
  }
};

/**
 * Keeps the copy up to date with the relay's `threads`, once `heard` says they came from it rather
 * than stand in for it, a moment after they last changed and as the page is hidden, which may be
 * the last chance a phone gives. Signing out forgets it. Does nothing outside the web client.
 */
export function useThreadsCache(options: {
  readonly enabled: boolean;
  readonly account: AccountState;
  /** Whether the account is known yet: signed out before then isn't signed out. */
  readonly accountKnown: boolean;
  readonly heard: boolean;
  readonly threads: AccountThreads;
}) {
  const { enabled, account, accountKnown, heard, threads } = options;
  const accountId = account._tag === "SignedIn" ? account.account.id : undefined;
  const signedOut = accountKnown && account._tag === "SignedOut";
  const write = useEffectEvent(() => {
    if (account._tag !== "SignedIn") return;
    // The threads can come before the relay lists the devices: the names kept last time stay.
    const devices =
      account.devices.length > 0
        ? account.devices.map((device) => ({ id: device.id, name: device.name }))
        : (cachedThreadsOf(cachedThreads(), account)?.devices ?? []);
    save({ account: account.account.id, savedAt: Date.now(), threads, devices });
  });
  useEffect(() => {
    if (enabled && signedOut) forgetCachedThreads();
  }, [enabled, signedOut]);
  useEffect(() => {
    if (!enabled || !heard || accountId === undefined) return;
    const timer = setTimeout(write, SAVE_AFTER_MS);
    const hidden = () => {
      if (document.visibilityState === "hidden") write();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [enabled, heard, accountId, threads]);
}
