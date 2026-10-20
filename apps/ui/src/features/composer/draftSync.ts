import { MAX_DRAFT_BYTES, type DraftEntry } from "@cerium/protocol";
import { Option } from "effect";

import type { Draft } from "./draft.ts";
import {
  decodeDraft,
  fingerprint,
  fromStored,
  keptDraft,
  toStored,
  withoutDraft,
  type DraftStamp,
  type DraftStamps,
  type Drafts,
  type StoredDraft,
} from "./drafts.ts";

// Drafts follow the user across the account's devices: each draft's latest edit, on whichever device,
// wins. The relay keeps every draft of the account; a window takes those newer than its own, and
// sends its own that are newer than the relay's. Comparing the two whole, rather than sending each
// change once, also brings back in step a device that wrote while offline.

/** A draft the cloud holds a newer edit of: its content, none once it's gone, and its new stamp. */
export interface TakenDraft {
  readonly key: string;
  readonly draft: StoredDraft | undefined;
  readonly stamp: DraftStamp;
}

export interface DraftSync {
  readonly take: ReadonlyArray<TakenDraft>;
  readonly send: ReadonlyArray<DraftEntry>;
}

/**
 * Drafts written before they were synced have no stamp: they count as older than any edit, so a
 * device signing in for the first time doesn't overwrite what the account's others wrote since.
 */
const UNSTAMPED_AT = 1;

/**
 * A new thread's draft names the machine it starts on, and none for this computer. Shared, it names
 * this computer by its id; `here` is that id on a desktop, and none in the web client, which always
 * names the machine it drives.
 */
const toCloud = (kept: StoredDraft, here: string | undefined): StoredDraft =>
  kept.start === undefined || kept.start.machine !== undefined || here === undefined
    ? kept
    : { ...kept, start: { ...kept.start, machine: here } };

const fromCloud = (kept: StoredDraft, here: string | undefined): StoredDraft => {
  if (kept.start?.machine === undefined || kept.start.machine !== here) return kept;
  const { machine: _, ...start } = kept.start;
  return { ...kept, start };
};

/** What the window takes from the cloud's drafts, and what it sends of its own. */
export const reconcileDrafts = (
  local: Drafts,
  stamps: DraftStamps,
  cloud: ReadonlyArray<DraftEntry>,
  here: string | undefined,
): DraftSync => {
  const stampOf = (key: string): DraftStamp | undefined => {
    const stamp = stamps[key];
    if (stamp !== undefined) return stamp;
    const kept = keptDraft(local[key]);
    return kept === undefined ? undefined : { at: UNSTAMPED_AT, hash: fingerprint(kept) };
  };
  const take: Array<TakenDraft> = [];
  const inCloud = new Map<string, number>();
  for (const entry of cloud) {
    inCloud.set(entry.key, entry.updatedAt);
    const own = stampOf(entry.key);
    if (own !== undefined && own.at >= entry.updatedAt) continue;
    if (entry.draft === undefined) {
      take.push({ key: entry.key, draft: undefined, stamp: { at: entry.updatedAt, hash: "" } });
      continue;
    }
    // A draft a newer version wrote that this one can't read stays as it is, here and there.
    const decoded = Option.getOrUndefined(decodeDraft(entry.draft));
    if (decoded === undefined) continue;
    const draft = fromCloud(decoded, here);
    take.push({ key: entry.key, draft, stamp: { at: entry.updatedAt, hash: fingerprint(draft) } });
  }
  const send: Array<DraftEntry> = [];
  for (const key of new Set([...Object.keys(stamps), ...Object.keys(local)])) {
    const own = stampOf(key);
    if (own === undefined || own.at <= (inCloud.get(key) ?? 0)) continue;
    // A draft never shared that's gone already has nothing to tell.
    const kept = keptDraft(local[key]);
    if (kept === undefined && !inCloud.has(key) && own.hash === "") continue;
    if (kept === undefined) {
      send.push({ key, updatedAt: own.at });
      continue;
    }
    const shared = toCloud(kept, here);
    if (JSON.stringify(shared).length > MAX_DRAFT_BYTES) continue;
    send.push({ key, updatedAt: own.at, draft: shared });
  }
  return { take, send };
};

/**
 * `drafts` with what was taken from the cloud. The window's own copy of a draft that holds the same
 * stays, so files it is still preparing and its image previews survive.
 */
export const applyTaken = (drafts: Drafts, take: ReadonlyArray<TakenDraft>): Drafts =>
  take.reduce((current, { key, draft }) => {
    if (draft === undefined) return withoutDraft(current, key);
    const own = current[key];
    if (own !== undefined && JSON.stringify(toStored(own)) === JSON.stringify(draft)) return current;
    const taken: Draft = fromStored(draft);
    return { ...current, [key]: taken };
  }, drafts);

/** How much of a message to the relay drafts may fill; the rest goes in the next. */
const BATCH_BYTES = 768_000;

/** `entries` in batches small enough for one message each. */
export const draftBatches = (
  entries: ReadonlyArray<DraftEntry>,
): ReadonlyArray<ReadonlyArray<DraftEntry>> => {
  const batches: Array<Array<DraftEntry>> = [];
  let size = 0;
  for (const entry of entries) {
    const bytes = JSON.stringify(entry).length;
    const last = batches.at(-1);
    if (last === undefined || size + bytes > BATCH_BYTES) {
      batches.push([entry]);
      size = bytes;
    } else {
      last.push(entry);
      size += bytes;
    }
  }
  return batches;
};
