import { Schema } from "effect";

import { DeviceId, ThreadId } from "./ids.ts";
import { MAX_THREAD_TITLE } from "./orchestration.ts";

// Push notifications: a thread's home machine says when it needs the user, finished or failed, and
// the relay tells the account's browsers by Web Push, unless the user is looking at it already.

/** What a notification is about: a thread waits on the user, its agents finished, or one failed. */
export const NotificationKind = Schema.Literals(["needsYou", "finished", "failed"]);
export type NotificationKind = typeof NotificationKind.Type;

export const NOTIFICATION_KINDS: ReadonlyArray<NotificationKind> = ["needsYou", "finished", "failed"];

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

/** What a device sends its relay socket about notifications. */
export const PushMessage = Schema.Union([
  /**
   * Whether this device's window is showing, and the thread open in it. Nobody is notified about a
   * thread someone is looking at, and a browser isn't sent notifications while it shows Cerium.
   */
  Schema.TaggedStruct("Presence", { visible: Schema.Boolean, viewing: Schema.optionalKey(ThreadRef) }),
  /** From a thread's home machine: the thread needs the user, finished or failed. */
  Schema.TaggedStruct("Notify", {
    threadId: ThreadId,
    kind: NotificationKind,
    title: Schema.String.check(Schema.isMaxLength(MAX_THREAD_TITLE)),
    /** What happened, in a line: the request, the last message, the error. */
    detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_DETAIL))),
  }),
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
  threadId: ThreadId,
  title: Schema.String,
  body: Schema.String,
});
export type PushPayload = typeof PushPayload.Type;
