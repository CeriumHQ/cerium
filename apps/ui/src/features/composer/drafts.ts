import { AccessMode, Attachment, MAX_THREAD_TITLE, Mention, ReasoningEffort } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";
import { draftText, hasContent, type Draft, type DraftAttachment, type DraftStart } from "./draft.ts";

// Every draft the window holds, by key: a thread's id, or `new:<uuid>` for a thread not started yet.
// They live in the window's local storage, so nothing that rebuilds the
// message box loses one: reconnecting, a reload, the web client moving to another build, the window
// turning phone-narrow. Files still being prepared, and image previews made in the page, stay in memory
// only; a restored image is read back from its saved file. Signed in, they follow the user to the
// account's other devices too (`draftSync.ts`).

export type Drafts = Readonly<Record<string, Draft>>;

const DRAFTS_KEY = "cerium:drafts";
const NEW_PREFIX = "new:";

/** The key of a thread not started yet. */
export const newDraftKey = (): string => `${NEW_PREFIX}${crypto.randomUUID()}`;

export const isNewDraftKey = (key: string | undefined): key is string => key?.startsWith(NEW_PREFIX) === true;

const StoredSegment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("mention"), mention: Mention }),
]);

const StoredDraft = Schema.Struct({
  segments: Schema.Array(StoredSegment),
  attachments: Schema.Array(Attachment),
  start: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.Literals(["work", "chat"]),
      createdAt: Schema.Finite,
      machine: Schema.optionalKey(Schema.String),
      folder: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      models: Schema.optionalKey(Schema.Array(Schema.String)),
      effort: Schema.optionalKey(ReasoningEffort),
      access: Schema.optionalKey(AccessMode),
      worktree: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type StoredDraft = typeof StoredDraft.Type;

export const decodeDraft = Schema.decodeUnknownOption(StoredDraft);

/** What storage keeps of a draft: its text, and the files that are ready to send. */
export const toStored = (draft: Draft): StoredDraft => ({
  segments: draft.segments,
  attachments: draft.attachments.flatMap((attachment) =>
    attachment.state._tag === "Ready" ? [attachment.state.attachment] : [],
  ),
  ...(draft.start ? { start: draft.start } : {}),
});

export const fromStored = (draft: StoredDraft): Draft => ({
  segments: draft.segments,
  attachments: draft.attachments.map((attachment): DraftAttachment => ({
    id: crypto.randomUUID(),
    name: attachment.name,
    mediaType: attachment.mediaType,
    state: { _tag: "Ready", attachment },
  })),
  ...(draft.start ? { start: draft.start } : {}),
});

/** What storage keeps of a draft, when it holds anything worth keeping. */
export const keptDraft = (draft: Draft | undefined): StoredDraft | undefined => {
  if (draft === undefined) return undefined;
  const kept = toStored(draft);
  return kept.attachments.length > 0 || draftText(kept.segments).trim() !== "" ? kept : undefined;
};

/** The drafts worth keeping, as storage holds them. */
export const serializeDrafts = (drafts: Drafts): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(drafts).flatMap(([key, draft]) => {
        const kept = keptDraft(draft);
        return kept ? [[key, kept]] : [];
      }),
    ),
  );

// Stamps: when each draft last changed in this window's storage, and a fingerprint of what it held
// then (empty once it's gone), so the account's devices can tell whose edit is the latest.

const STAMPS_KEY = "cerium:draft-stamps";

export interface DraftStamp {
  readonly at: number;
  readonly hash: string;
}
export type DraftStamps = Readonly<Record<string, DraftStamp>>;

const decodeStamps = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ at: Schema.Finite, hash: Schema.String })),
  ),
);

/** How long a gone draft's stamp is kept, against a device that was offline bringing it back. */
const GONE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export const readStamps = (): DraftStamps =>
  Option.getOrElse(decodeStamps(stored(STAMPS_KEY) ?? ""), () => ({}));

export const writeStamps = (stamps: DraftStamps) => remember(STAMPS_KEY, JSON.stringify(stamps));

/** A short fingerprint of what a draft keeps, `""` when it keeps nothing. */
export const fingerprint = (kept: StoredDraft | undefined): string => {
  if (kept === undefined) return "";
  const text = JSON.stringify(kept);
  // FNV-1a over the UTF-16 units, with the length: enough to tell one edit from the next.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
};

/** `stamps` after `previous` became `next` at `now`: each draft whose content changed is stamped. */
export const stampChanges = (
  previous: Drafts,
  next: Drafts,
  stamps: DraftStamps,
  now: number,
): DraftStamps => {
  const changed: Record<string, DraftStamp> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[key] === next[key]) continue;
    const hash = fingerprint(keptDraft(next[key]));
    if ((stamps[key]?.hash ?? "") !== hash) changed[key] = { at: now, hash };
  }
  const gone = Object.entries(stamps).filter(
    ([, stamp]) => stamp.hash === "" && stamp.at < now - GONE_KEPT_MS,
  );
  if (Object.keys(changed).length === 0 && gone.length === 0) return stamps;
  const kept = { ...stamps, ...changed };
  for (const [key] of gone) if (!(key in changed)) delete kept[key];
  return kept;
};

/** The drafts storage holds; one that no longer reads is dropped without losing the others. */
export const parseDrafts = (text: string | undefined): Drafts => {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) =>
      Option.match(decodeDraft(value), {
        onNone: () => [],
        onSome: (draft) => [[key, fromStored(draft)]],
      }),
    ),
  );
};

/**
 * `incoming` (another tab's drafts) with this window's own copy of each draft that didn't change
 * there, so files it is still preparing and its image previews survive.
 */
export const mergeDrafts = (current: Drafts, incoming: Drafts): Drafts =>
  Object.fromEntries(
    Object.entries(incoming).map(([key, draft]) => {
      const own = current[key];
      return [key, own && JSON.stringify(toStored(own)) === JSON.stringify(toStored(draft)) ? own : draft];
    }),
  );

/** The window's drafts, kept in local storage and in step with its other tabs. */
export const draftsAtom: Atom.Writable<Drafts> = Atom.writable(
  (get): Drafts => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DRAFTS_KEY) return;
      const current = Option.getOrElse(get.self<Drafts>(), () => ({}));
      get.setSelf(mergeDrafts(current, parseDrafts(event.newValue ?? undefined)));
    };
    window.addEventListener("storage", onStorage);
    get.addFinalizer(() => window.removeEventListener("storage", onStorage));
    return parseDrafts(stored(DRAFTS_KEY));
  },
  (context, drafts: Drafts) => {
    const previous = context.get(draftsAtom);
    const stamps = readStamps();
    const stamped = stampChanges(previous, drafts, stamps, Date.now());
    if (stamped !== stamps) writeStamps(stamped);
    context.setSelf(drafts);
    remember(DRAFTS_KEY, serializeDrafts(drafts));
  },
).pipe(Atom.keepAlive);

/** How a thread not started yet starts, from the moment the user first writes or picks in it. */
export const startedNow = (start: Omit<DraftStart, "createdAt">): DraftStart => ({
  ...start,
  createdAt: Date.now(),
});

/** `drafts` with `key`'s draft changed; an emptied one that isn't a new thread's is dropped. */
export const withDraft = (drafts: Drafts, key: string, update: (draft: Draft) => Draft): Drafts => {
  const next = update(drafts[key] ?? { segments: [], attachments: [] });
  return next.start === undefined && !hasContent(next)
    ? withoutDraft(drafts, key)
    : { ...drafts, [key]: next };
};

/** `drafts` without `key`'s. */
export const withoutDraft = (drafts: Drafts, key: string): Drafts => {
  if (!(key in drafts)) return drafts;
  const rest = { ...drafts };
  delete rest[key];
  return rest;
};

/** A thread not started yet, as the sidebar lists it. */
export interface NewThreadDraft {
  readonly key: string;
  readonly mode: DraftStart["mode"];
  readonly createdAt: number;
  readonly machine?: string;
  readonly folder?: string;
  /** What the thread would be called if it started now. */
  readonly title: string;
  /** The draft has only files so far. */
  readonly untitled: boolean;
  readonly attachments: number;
}

/** What a new thread is called: the first line of its message, or its first file's name. */
export const draftTitle = (draft: Draft): string =>
  (draftText(draft.segments).trim().split("\n")[0]?.trim() || draft.attachments[0]?.name || "").slice(
    0,
    MAX_THREAD_TITLE,
  );

/** The threads not started yet that have something in them, newest first. */
export const newThreadDrafts = (drafts: Drafts): ReadonlyArray<NewThreadDraft> =>
  Object.entries(drafts)
    .flatMap(([key, draft]): ReadonlyArray<NewThreadDraft> => {
      const { start } = draft;
      if (!isNewDraftKey(key) || start === undefined || !hasContent(draft)) return [];
      const title = draftTitle(draft);
      return [
        {
          key,
          mode: start.mode,
          createdAt: start.createdAt,
          ...(start.machine === undefined ? {} : { machine: start.machine }),
          ...(start.folder === undefined ? {} : { folder: start.folder }),
          title: title || "Untitled draft",
          untitled: draftText(draft.segments).trim() === "",
          attachments: draft.attachments.length,
        },
      ];
    })
    .sort((a, b) => b.createdAt - a.createdAt);

const sameDrafts = (a: ReadonlyArray<NewThreadDraft>, b: ReadonlyArray<NewThreadDraft>) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/** The sidebar's drafts, which change only when one is added, retitled or removed, not on every key. */
export const newThreadDraftsAtom = Atom.make((get) => newThreadDrafts(get(draftsAtom))).pipe(
  Atom.withEquality(sameDrafts),
);

/** How a draft starts, for the parts of the window that show it without its text. */
export const draftStartAtom = Atom.family((key: string) =>
  Atom.make((get) => get(draftsAtom)[key]?.start).pipe(
    Atom.withEquality<DraftStart | undefined>((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  ),
);
