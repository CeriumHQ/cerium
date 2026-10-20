import { Schema } from "effect";

import { DeviceId, ThreadId } from "./ids.ts";
import { MAX_THREAD_TITLE } from "./orchestration.ts";

// Push notifications: a thread's home machine says when it needs the user, finished or failed, or
// when a subscription's usage limit nears, and the relay tells the account's browsers by Web Push,
// unless the user is looking at it already.

/**
 * What a notification is about: a thread waits on the user, its agents finished, or one failed; or a
 * usage meter of a harness's subscription nears its limit, which belongs to no thread.
 */
export const NotificationKind = Schema.Literals(["needsYou", "finished", "failed", "limit"]);
export type NotificationKind = typeof NotificationKind.Type;

export const NOTIFICATION_KINDS: ReadonlyArray<NotificationKind> = [
  "needsYou",
  "finished",
  "failed",
  "limit",
];

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/** A browser's push subscription (the Push API's `PushSubscription.toJSON()`), for the relay to send to. */
export const PushSubscriptionInfo = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/), Schema.isMaxLength(2048)),
  keys: Schema.Struct({ p256dh: Base64Url, auth: Base64Url }),
});
export type PushSubscriptionInfo = typeof PushSubscriptionInfo.Type;

/** A thread of the account: the machine it lives on, and its id there. */
export const ThreadRef = Schema.Struct({ machine: DeviceId, threadId: ThreadId });
export type ThreadRef = typeof ThreadRef.Type;

/** The longest detail a notification carries, in characters. */
export const MAX_NOTIFICATION_DETAIL = 240;

/**
 * A thread of this machine needs the user, finished or failed, or a usage limit of this machine's
 * harnesses nears: what its home machine tells the relay, and its own desktop shows natively.
 */
export const ThreadNotification = Schema.Struct({
  /** The thread it is about; absent for a `limit`, which is about a subscription. */
  threadId: Schema.optionalKey(ThreadId),
  kind: NotificationKind,
  /** The thread's title, or the meter a `limit` is about. */
  title: Schema.String.check(Schema.isMaxLength(MAX_THREAD_TITLE)),
  /** What happened, in a line: the request, the last message, the error, what is left of a meter. */
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_DETAIL))),
});
export type ThreadNotification = typeof ThreadNotification.Type;

const headlines: Record<NotificationKind, string> = {
  needsYou: "Waiting for your approval",
  finished: "Finished",
  failed: "Failed",
  limit: "Usage limit",
};

/**
 * The text under a notification's title: what happened, on which computer when the account has
 * more than one, then the detail on a line of its own.
 */
export const notificationBody = (kind: NotificationKind, detail?: string, machine?: string): string => {
  const headline = machine === undefined ? headlines[kind] : `${headlines[kind]} on ${machine}`;
  return detail === undefined || detail.trim() === "" ? headline : `${headline}\n${detail.trim()}`;
};

/** What a device sends its relay socket about notifications. */
export const PushMessage = Schema.Union([
  /**
   * Whether this device's window is showing, and the thread open in it. Nobody is notified about a
   * thread someone is looking at, and a browser isn't sent notifications while it shows Cerium.
   */
  Schema.TaggedStruct("Presence", { visible: Schema.Boolean, viewing: Schema.optionalKey(ThreadRef) }),
  /** From a thread's home machine: the thread needs the user, finished or failed. */
  Schema.TaggedStruct("Notify", ThreadNotification.fields),
  /** From a browser: send it these kinds of notifications, here. Replaces what it had. */
  Schema.TaggedStruct("PushSubscribe", {
    subscription: PushSubscriptionInfo,
    kinds: Schema.Array(NotificationKind),
  }),
  /** From a browser: send it no more notifications. */
  Schema.TaggedStruct("PushUnsubscribe", {}),
]);
export type PushMessage = typeof PushMessage.Type;

/** What a push carries to the browser's service worker, which shows it. */
export const PushPayload = Schema.Struct({
  kind: NotificationKind,
  machine: DeviceId,
  threadId: Schema.optionalKey(ThreadId),
  title: Schema.String,
  body: Schema.String,
});
export type PushPayload = typeof PushPayload.Type;
