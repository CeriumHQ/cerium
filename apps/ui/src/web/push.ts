import type { AccountState, PushSubscriptionInfo } from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { subscribePush, unsubscribePush } from "../backend/atoms.ts";
import { WEB } from "../backend/target.ts";
import { OPEN_MESSAGE, OPEN_PARAMS } from "./serviceWorker.ts";

// Push notifications on this browser: its service worker, its
// subscription with the browser's push service, and the threads notifications open. The relay keeps
// which kinds this browser wants (its device's `notifications`); the browser keeps the subscription.

/**
 * Whether this browser can get notifications now; `install` when a phone or tablet's browser only
 * notifies web apps on the Home Screen (Safari on iOS and iPadOS among them), and Cerium isn't there.
 */
export type PushSupport = "supported" | "install" | "unsupported";

/** Cerium runs from the Home Screen or as an installed app, not in a browser tab. */
const installed = () =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

export const pushSupport = (): PushSupport => {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "supported";
  const agent = navigator.userAgent;
  // iPadOS asks for the desktop site as a Mac; only its touch screen tells it apart.
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/.test(agent) ||
    (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  return mobile && !installed() ? "install" : "unsupported";
};

/** Why the browser won't notify: the user said no, now or before. */
export class PushBlocked extends Error {}

let pushKey: Promise<string | undefined> | undefined;

/** The relay's public VAPID key, which subscriptions are made for; none when it sends no notifications. */
export const relayPushKey = (): Promise<string | undefined> =>
  (pushKey ??= fetch("/api/config", { cache: "no-store" })
    .then(async (response): Promise<{ vapidPublicKey?: unknown }> => {
      // A refusal, such as too many requests, says nothing about the key.
      if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
      return response.json();
    })
    .then(({ vapidPublicKey }) => (typeof vapidPublicKey === "string" ? vapidPublicKey : undefined))
    .catch(() => {
      // Asked again next time.
      pushKey = undefined;
      return undefined;
    }));

/** Registers the service worker, which shows notifications and opens their threads. */
export const registerServiceWorker = () =>
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });

const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

const madeFor = (subscription: PushSubscription, key: string) => {
  const current = subscription.options.applicationServerKey;
  const expected = keyBytes(key);
  if (current === null || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
};

const asInfo = (subscription: PushSubscription): PushSubscriptionInfo => {
  const { endpoint, keys } = subscription.toJSON();
  const p256dh = keys?.["p256dh"];
  const auth = keys?.["auth"];
  if (!endpoint || !p256dh || !auth) throw new Error("This browser made a subscription without its keys.");
  return { endpoint, keys: { p256dh, auth } };
};

/** This browser's subscription for the relay's key: the one it has, or a new one. */
const subscription = async (key: string): Promise<PushSubscriptionInfo> => {
  const registration = await registerServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null && madeFor(existing, key)) return asInfo(existing);
  // One made for another key can't receive from this relay any more.
  await existing?.unsubscribe();
  return asInfo(
    await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }),
  );
};

/**
 * Asks to notify, then subscribes. Call it straight from the user's tap: some browsers, mobile Safari
 * among them, only ask in answer to one.
 */
export const turnOnPush = async (key: string): Promise<PushSubscriptionInfo> => {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushBlocked(permission);
  return subscription(key);
};

/** Ends this browser's subscription, if it has one. */
export const turnOffPush = async () => {
  const registration = await navigator.serviceWorker.getRegistration("/");
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
};

/** Shows a notification now, the way one from the relay would, to check this browser shows them. */
export const showTestNotification = async () => {
  // Not `serviceWorker.ready`, which waits forever when the worker never registered.
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration === undefined)
    throw new Error("Cerium's service worker isn't running. Reload and try again.");
  // Untagged, so each test shows rather than quietly replacing the last.
  await registration.showNotification("Cerium", {
    body: "Notifications are on for this browser.",
    icon: "/icon-192.png",
  });
};

/** The kinds of notification this browser gets, as the relay has them; none while they're off. */
export const notificationsOf = (account: AccountState) =>
  account._tag === "SignedIn"
    ? account.devices.find((device) => device.id === account.deviceId)?.notifications
    : undefined;

/**
 * Keeps a browser with notifications on subscribed, each time Cerium opens: the browser may have
 * renewed its subscription, or the relay its key. A browser no longer allowed to notify turns them off.
 */
export function useRenewPush(account: AccountState) {
  const subscribe = useAtomSet(subscribePush, { mode: "promise" });
  const unsubscribe = useAtomSet(unsubscribePush, { mode: "promise" });
  const online = account._tag === "SignedIn" && account.connection === "online";
  const kinds = notificationsOf(account);
  const renew = useEffectEvent(async () => {
    if (!WEB || kinds === undefined || pushSupport() !== "supported") return;
    if (Notification.permission === "denied") return await unsubscribe({ payload: undefined });
    const key = await relayPushKey();
    if (key === undefined || Notification.permission !== "granted") return;
    await subscribe({ payload: { subscription: await subscription(key), kinds } });
  });
  // Once a connection, when it's known whether this browser has them on.
  const on = kinds !== undefined;
  useEffect(() => {
    if (online && on) void renew().catch(() => undefined);
  }, [online, on]);
}

/** A tapped notification's thread, and which tap: tapping one again opens it again. */
interface Tapped {
  readonly threadId: string;
  readonly tap: number;
}

let taps = 0;

/** The thread of the notification whose tap opened Cerium, from the address. */
const tappedAtLaunch = (): Tapped | undefined => {
  const threadId = new URLSearchParams(location.search).get(OPEN_PARAMS.thread);
  return threadId ? { threadId, tap: ++taps } : undefined;
};

/**
 * Opens the thread of a tapped notification once `find` knows it: from the address, when the tap
 * opened Cerium, from the service worker, when Cerium was open already, or from the desktop's
 * shell, when its own notification was clicked. Threads arrive after
 * Cerium starts, so a tap waits for its thread.
 */
export function useNotificationOpens<T>(
  find: (threadId: string) => T | undefined,
  open: (thread: T) => void,
) {
  const [tapped, setTapped] = useState(tappedAtLaunch);
  const opened = useRef(0);
  const onOpen = useEffectEvent(open);
  const found = tapped === undefined ? undefined : find(tapped.threadId);
  useEffect(() => {
    if (tapped === undefined || found === undefined || opened.current === tapped.tap) return;
    opened.current = tapped.tap;
    onOpen(found);
  }, [tapped, found]);
  useEffect(() => {
    if (new URLSearchParams(location.search).has(OPEN_PARAMS.thread))
      history.replaceState(history.state, "", location.pathname);
    // The desktop's own notifications come through its shell (desktop/notifications.ts).
    const shell = window.cerium?.onOpenThread;
    if (shell !== undefined) return shell((threadId) => setTapped({ threadId, tap: ++taps }));
    if (!WEB || !("serviceWorker" in navigator)) return;
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; threadId?: unknown } | null;
      if (data?.type === OPEN_MESSAGE && typeof data.threadId === "string")
        setTapped({ threadId: data.threadId, tap: ++taps });
    };
    navigator.serviceWorker.addEventListener("message", listener);
    navigator.serviceWorker.startMessages();
    return () => navigator.serviceWorker.removeEventListener("message", listener);
  }, []);
}
