import type { AgentEvent, FromUser } from "@cerium/protocol";

import { segmentsOf, type Segment } from "./draft.ts";

const HISTORY_LIMIT = 50;
type Entry = ReadonlyArray<Segment>;

/** Prompts the lead accepted, including queued messages it hasn't taken yet. */
export const sentPrompts = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<Entry> => {
  const messages = new Map<string, { message: FromUser; deliveredAt?: number }>();
  for (const { id, sequence, payload } of events) {
    switch (payload._tag) {
      case "MessageQueued":
        messages.set(payload.message.id ?? id, { message: payload.message });
        break;
      case "TurnInput":
        for (const [index, message] of payload.items.entries()) {
          if (message._tag === "FromUser") {
            messages.set(message.id ?? `${id}:${index}`, { message, deliveredAt: sequence });
          }
        }
        break;
      case "MessageWithdrawn":
        if (messages.get(payload.messageId)?.deliveredAt === undefined) messages.delete(payload.messageId);
        break;
      case "ConversationRewound":
        for (const [key, { deliveredAt }] of messages) {
          if (deliveredAt === undefined || deliveredAt >= payload.fromSequence) messages.delete(key);
        }
        break;
    }
  }
  return [...messages.values()]
    .filter(({ message }) => message.writtenBy === undefined && message.text.trim() !== "")
    .slice(-HISTORY_LIMIT)
    .map(({ message }) => segmentsOf(message.text, message.mentions ?? []));
};

export interface BrowsingHistory {
  readonly entries: ReadonlyArray<Entry>;
  readonly index: number;
  readonly draft: Entry;
}

/** The caller's draft or an entry from a snapshot, so new events don't move an in-progress cursor. */
export const recalledPrompt = (history: BrowsingHistory): Entry => history.entries[history.index]!;

export const stepPromptHistory = ({
  direction,
  history,
  entries,
  draft,
  atStart,
  empty,
  blocked,
}: {
  readonly direction: "older" | "newer";
  readonly history: BrowsingHistory | undefined;
  readonly entries: ReadonlyArray<Entry>;
  readonly draft: Entry;
  readonly atStart: boolean;
  readonly empty: boolean;
  readonly blocked: boolean;
}): { readonly history: BrowsingHistory | undefined } | undefined => {
  if (blocked) return undefined;
  // A change to the live draft ends recall, including changes from other tabs or devices.
  if (history?.draft !== draft) history = undefined;
  if (history === undefined) {
    if (direction !== "older" || !atStart || !empty || entries.length === 0) return undefined;
    return { history: { entries, index: entries.length - 1, draft } };
  }
  const index = direction === "older" ? Math.max(0, history.index - 1) : history.index + 1;
  return { history: index === history.entries.length ? undefined : { ...history, index } };
};
