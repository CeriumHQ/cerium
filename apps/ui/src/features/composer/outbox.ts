import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Attachment, Mention } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import type { ConnectionState } from "../../backend/liveness.ts";
import type { DrivenMachine } from "../../backend/machine.ts";
import { remember, stored } from "../../lib/storage.ts";
import type { OutgoingMessage } from "./composerTypes.ts";
import { draftText, type Draft, type Segment } from "./draft.ts";
import { draftsAtom, withDraft } from "./drafts.ts";

// Messages written to a thread while its machine can't be reached: a phone in a tunnel, a desktop
// asleep, a line coming back. Each waits here, in the window's local storage so a reload keeps it,
// until the machine is back and the thread has a lead, then goes in the order it was written. One
// that fails stops the ones behind it, so the lead never reads them out of order.

export type OutboxStatus = "queued" | "sending" | "failed";

/** The machine a message goes to: another desktop's id, or this computer's own. */
export const LOCAL_MACHINE = "local";

export interface OutboxEntry {
  readonly id: string;
  readonly machine: string;
  readonly threadId: string;
  /** The message as the box held it, for giving it back to the draft. */
  readonly segments: ReadonlyArray<Segment>;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: ReadonlyArray<Mention>;
  readonly createdAt: number;
  readonly status: OutboxStatus;
  /** Why it failed, written for the user. */
  readonly error?: string;
}

/** Every waiting message, oldest first. */
export type Outbox = ReadonlyArray<OutboxEntry>;

const OUTBOX_KEY = "cerium:outbox";

/** The machine an entry goes to, from the one the window drives. */
export const outboxMachine = (machine: DrivenMachine | undefined): string => machine?.id ?? LOCAL_MACHINE;

/** One thread's place in the outbox. */
export const outboxKey = (machine: string, threadId: string): string => `${machine}/${threadId}`;

/** Whether a message to a machine in `state` waits here rather than going now. */
export const shouldQueue = (state: ConnectionState): boolean => state !== "connected";

/** Whether a thread's waiting messages can go: its machine is back and it has a lead to take them. */
export const outboxReady = (state: ConnectionState, leadId: string | undefined): boolean =>
  state === "connected" && leadId !== undefined;

const INTERRUPTED = "Interrupted while sending. Check the thread before retrying.";
const NOT_SENT = "Not sent.";

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : NOT_SENT;

// ---- The outbox as data ---------------------------------------------------------------------

/** `outbox` with a new message for `threadId` at its end, and that message. */
export const enqueue = (
  outbox: Outbox,
  target: { readonly machine: string; readonly threadId: string },
  message: OutgoingMessage,
  segments: ReadonlyArray<Segment>,
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
): readonly [Outbox, OutboxEntry] => {
  const entry: OutboxEntry = {
    id,
    machine: target.machine,
    threadId: target.threadId,
    segments,
    text: message.text,
    attachments: message.attachments,
    mentions: message.mentions,
    createdAt: now,
    status: "queued",
  };
  return [[...outbox, entry], entry];
};

export const withoutEntry = (outbox: Outbox, id: string): Outbox =>
  outbox.some((entry) => entry.id === id) ? outbox.filter((entry) => entry.id !== id) : outbox;

export const withStatus = (outbox: Outbox, id: string, status: OutboxStatus, error?: string): Outbox =>
  outbox.some((entry) => entry.id === id)
    ? outbox.map((entry) => {
        if (entry.id !== id) return entry;
        const { error: _, ...rest } = entry;
        return error === undefined ? { ...rest, status } : { ...rest, status, error };
      })
    : outbox;

/** One thread's waiting messages, oldest first. */
export const entriesFor = (outbox: Outbox, machine: string, threadId: string): Outbox =>
  outbox.filter((entry) => entry.machine === machine && entry.threadId === threadId);

/**
 * The thread's message to send next: its oldest, while it waits. One sending or failed holds the
 * rest back.
 */
export const nextToSend = (outbox: Outbox, machine: string, threadId: string): OutboxEntry | undefined => {
  const head = outbox.find((entry) => entry.machine === machine && entry.threadId === threadId);
  return head?.status === "queued" ? head : undefined;
};

/** What an entry sends. */
export const entryMessage = (entry: OutboxEntry): OutgoingMessage => ({
  text: entry.text,
  attachments: entry.attachments,
  mentions: entry.mentions,
});

/** `current` with the entry's message given back to it, after whatever the box holds already. */
export const restoredDraft = (current: Draft | undefined, entry: OutboxEntry): Draft => {
  const attachments = entry.attachments.map((attachment) => ({
    id: crypto.randomUUID(),
    name: attachment.name,
    mediaType: attachment.mediaType,
    state: { _tag: "Ready" as const, attachment },
  }));
  const base: Draft = current ?? { segments: [], attachments: [] };
  const separator: ReadonlyArray<Segment> =
    entry.segments.length === 0 ? [] : [{ kind: "text", text: "\n\n" }];
  return {
    ...base,
    segments:
      draftText(base.segments).trim() === ""
        ? entry.segments
        : [...base.segments, ...separator, ...entry.segments],
    attachments: [...base.attachments, ...attachments],
  };
};

// ---- Storage --------------------------------------------------------------------------------

const StoredSegment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("mention"), mention: Mention }),
]);

const StoredEntry = Schema.Struct({
  id: Schema.String,
  machine: Schema.String,
  threadId: Schema.String,
  segments: Schema.Array(StoredSegment),
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  createdAt: Schema.Finite,
  status: Schema.Literals(["queued", "sending", "failed"]),
  error: Schema.optionalKey(Schema.String),
});

const decodeEntry = Schema.decodeUnknownOption(StoredEntry);

export const serializeOutbox = (outbox: Outbox): string => JSON.stringify(outbox);

/**
 * The outbox storage holds; an entry that no longer reads is dropped without losing the others. One
 * left sending by a window that closed may have arrived, so it waits for the user, not a retry.
 */
export const parseOutbox = (text: string | undefined): Outbox => {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): Outbox => {
    const entry = Option.getOrUndefined(decodeEntry(value));
    if (entry === undefined) return [];
    return [entry.status === "sending" ? { ...entry, status: "failed", error: INTERRUPTED } : entry];
  });
};

/** The window's outbox, kept in local storage and in step with its other tabs. */
export const outboxAtom: Atom.Writable<Outbox> = Atom.writable(
  (get): Outbox => {
    if (typeof window !== "undefined") {
      const onStorage = (event: StorageEvent) => {
        if (event.key === OUTBOX_KEY) get.setSelf(parseOutbox(event.newValue ?? undefined));
      };
      window.addEventListener("storage", onStorage);
      get.addFinalizer(() => window.removeEventListener("storage", onStorage));
    }
    return parseOutbox(stored(OUTBOX_KEY));
  },
  (context, outbox: Outbox) => {
    context.setSelf(outbox);
    remember(OUTBOX_KEY, serializeOutbox(outbox));
  },
).pipe(Atom.keepAlive);

/** One thread's waiting messages, which change only when they do. */
export const threadOutboxAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    get(outboxAtom).filter((entry) => outboxKey(entry.machine, entry.threadId) === key),
  ).pipe(
    Atom.withEquality<Outbox>(
      (a, b) => a.length === b.length && a.every((entry, index) => entry === b[index]),
    ),
  ),
);

// ---- Actions --------------------------------------------------------------------------------

type Registry = AtomRegistry.AtomRegistry;

const update = (registry: Registry, change: (outbox: Outbox) => Outbox) =>
  registry.set(outboxAtom, change(registry.get(outboxAtom)));

/** Keeps a message for `threadId` until its machine is back. */
export const queueMessage = (
  registry: Registry,
  target: { readonly machine: string; readonly threadId: string },
  message: OutgoingMessage,
  segments: ReadonlyArray<Segment>,
): OutboxEntry => {
  const [outbox, entry] = enqueue(registry.get(outboxAtom), target, message, segments);
  registry.set(outboxAtom, outbox);
  return entry;
};

/** Drops a waiting message unsent. */
export const cancelMessage = (registry: Registry, id: string) =>
  update(registry, (outbox) => withoutEntry(outbox, id));

/** Puts a failed message back in line, where it goes before the ones written after it. */
export const retryMessage = (registry: Registry, id: string) =>
  update(registry, (outbox) =>
    outbox.find((entry) => entry.id === id)?.status === "failed" ? withStatus(outbox, id, "queued") : outbox,
  );

/**
 * Takes a waiting message out of the outbox and gives it back to the draft `draftKey` to edit. Not
 * one being sent: it may already be on its way.
 */
export const restoreToDraft = (registry: Registry, id: string, draftKey: string): boolean => {
  const entry = registry.get(outboxAtom).find((each) => each.id === id);
  if (entry === undefined || entry.status === "sending") return false;
  registry.set(
    draftsAtom,
    withDraft(registry.get(draftsAtom), draftKey, (draft) => restoredDraft(draft, entry)),
  );
  cancelMessage(registry, id);
  return true;
};

const flushing = new Set<string>();

export interface FlushOptions {
  readonly machine: string;
  readonly threadId: string;
  /** Sends one message; resolving `false` or rejecting means it didn't go. */
  readonly send: (message: OutgoingMessage) => Promise<unknown>;
  /** Whether the thread can still take messages; a send that fails once it can't waits to go again. */
  readonly ready?: () => boolean;
}

/**
 * Sends a thread's waiting messages one by one, oldest first, until none waits or one fails.
 * Resolves how many went. A flush already under way for the thread makes this one do nothing.
 */
export const flushOutbox = async (registry: Registry, options: FlushOptions): Promise<number> => {
  const { machine, threadId, send, ready = () => true } = options;
  const key = outboxKey(machine, threadId);
  if (flushing.has(key)) return 0;
  flushing.add(key);
  let sent = 0;
  try {
    for (let next = nextToSend(registry.get(outboxAtom), machine, threadId); next !== undefined && ready();) {
      const { id } = next;
      update(registry, (outbox) => withStatus(outbox, id, "sending"));
      const error = await send(entryMessage(next)).then(
        (result) => (result === false ? NOT_SENT : undefined),
        messageOf,
      );
      if (error === undefined) {
        update(registry, (outbox) => withoutEntry(outbox, id));
        sent++;
      } else {
        // The line dropped under it: it goes again when the machine is back.
        update(registry, (outbox) =>
          ready() ? withStatus(outbox, id, "failed", error) : withStatus(outbox, id, "queued"),
        );
        break;
      }
      next = nextToSend(registry.get(outboxAtom), machine, threadId);
    }
  } finally {
    flushing.delete(key);
  }
  return sent;
};

/**
 * Sends a thread's waiting messages as soon as `ready` (see `outboxReady`), and again whenever one is
 * put back in line. Returns the thread's waiting messages, for the box to show.
 */
export function useOutboxFlush(options: {
  readonly machine: string;
  readonly threadId: string | undefined;
  readonly ready: boolean;
  readonly send: (message: OutgoingMessage) => Promise<unknown>;
}): Outbox {
  const { machine, threadId, ready } = options;
  const registry = useContext(RegistryContext);
  const entries = useAtomValue(threadOutboxAtom(outboxKey(machine, threadId ?? "")));
  const head = entries[0];
  const waiting = head?.status === "queued" ? head.id : undefined;
  const send = useEffectEvent((message: OutgoingMessage) => options.send(message));
  const isReady = useEffectEvent(() => options.ready);
  useEffect(() => {
    if (!ready || threadId === undefined || waiting === undefined) return;
    void flushOutbox(registry, { machine, threadId, send, ready: isReady });
  }, [registry, machine, threadId, ready, waiting]);
  return threadId === undefined ? [] : entries;
}
