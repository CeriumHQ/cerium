import { NOTIFICATION_KINDS, type NotificationKind } from "@cerium/protocol";

import type { DeviceRow } from "./devices.ts";

// Who a notification goes to (docs/architecture.md §14.11). Plain functions over the Account
// object's rows and connections, so they're tested without the Workers runtime.

/** A row of the Account object's `push` table: a browser's subscription and the kinds it wants. */
export type PushRow = {
  readonly device: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /** JSON array of `NotificationKind`. */
  readonly kinds: string;
  readonly updated_at: number;
};

/** What a connection last said about its window (`Presence`), and when. */
export interface Presence {
  readonly visible?: boolean;
  /** The thread open in it, as `threadKey` names it. */
  readonly viewing?: string;
  readonly presenceAt?: number;
}

/**
 * A window that said it shows, but hasn't been heard from for this long, has likely been suspended,
 * as a phone does to a Home Screen app in the background. Devices ping every 25 seconds.
 */
export const PRESENCE_FRESH_MS = 50_000;

export const threadKey = (machine: string, threadId: string) => `${machine}:${threadId}`;

/** Whether a connection's window shows now: it said so, and it was heard from since `lastHeard`. */
export const isShowing = (presence: Presence, lastHeard: number, now: number): boolean =>
  presence.visible === true && now - Math.max(lastHeard, presence.presenceAt ?? 0) < PRESENCE_FRESH_MS;

export const kindsOf = (row: PushRow): ReadonlyArray<NotificationKind> => {
  try {
    const kinds: unknown = JSON.parse(row.kinds);
    return Array.isArray(kinds) ? NOTIFICATION_KINDS.filter((kind) => kinds.includes(kind)) : [];
  } catch {
    return [];
  }
};

/**
 * The subscriptions a notification about thread `key` goes to: approved browsers that want its
 * kind and aren't showing Cerium now. None while any window shows that thread: whoever looks at it
 * sees what happened there.
 */
export const recipients = (
  kind: NotificationKind,
  key: string,
  subscriptions: ReadonlyArray<PushRow>,
  devices: ReadonlyArray<DeviceRow>,
  showing: ReadonlyArray<Presence & { readonly deviceId: string }>,
): ReadonlyArray<PushRow> => {
  if (showing.some((window) => window.viewing === key)) return [];
  const shown = new Set(showing.map((window) => window.deviceId));
  const browsers = new Set(
    devices.filter((row) => row.kind === "browser" && row.approved_at !== null).map((row) => row.id),
  );
  return subscriptions.filter(
    (row) => browsers.has(row.device) && !shown.has(row.device) && kindsOf(row).includes(kind),
  );
};

const headlines: Record<NotificationKind, string> = {
  needsYou: "Waiting for your approval",
  finished: "Finished",
  failed: "Failed",
};

/**
 * The text under a notification's title: what happened, on which computer when the account has
 * more than one, then the detail on a line of its own.
 */
export const notificationBody = (kind: NotificationKind, detail?: string, machine?: string): string => {
  const headline = machine === undefined ? headlines[kind] : `${headlines[kind]} on ${machine}`;
  return detail === undefined || detail.trim() === "" ? headline : `${headline}\n${detail.trim()}`;
};
