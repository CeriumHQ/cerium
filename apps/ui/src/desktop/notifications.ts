import { notificationBody } from "@cerium/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { notificationsAtom, type Arrived } from "../backend/atoms.ts";
import { shellBridge } from "../backend/shell.ts";
import { notifyBadgeAtom, notifyKindsAtom, notifySoundAtom } from "../features/settings/preferences.ts";
import { badgeText, handling } from "./model.ts";

// The desktop's own notifications about this computer's threads. The backend says when a thread
// needs the user, finished or failed (apps/backend/src/notify.ts); the window decides whether the
// user would see it anyway, and the shell shows it (apps/desktop/src/notifications.ts). The web
// client's come by Web Push instead (web/push.ts).

/** The badge, drawn in the theme's accent: a PNG data URL Windows lays over the taskbar icon. */
const drawBadge = (count: number): string | undefined => {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  // Read from the tokens through an element, which resolves them to colours a canvas takes.
  const probe = document.createElement("span");
  probe.className = "bg-accent text-accent-fg";
  document.body.append(probe);
  const { backgroundColor, color, fontFamily } = getComputedStyle(probe);
  probe.remove();
  context.fillStyle = backgroundColor;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.fill();
  const text = badgeText(count);
  context.fillStyle = color;
  context.font = `600 ${text.length > 1 ? 16 : 20}px ${fontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size / 2, size / 2 + 1);
  return canvas.toDataURL("image/png");
};

const onFocusChange = (change: () => void) => {
  window.addEventListener("focus", change);
  window.addEventListener("blur", change);
  document.addEventListener("visibilitychange", change);
  return () => {
    window.removeEventListener("focus", change);
    window.removeEventListener("blur", change);
    document.removeEventListener("visibilitychange", change);
  };
};
const atWindow = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Shows this computer's threads' notifications natively while the user is away from the window,
 * and counts the threads that notified on the taskbar until the user opens each. `viewing` is the
 * thread the window shows, when it's one of this computer's.
 */
export function useDesktopNotifications(viewing: string | undefined) {
  const bridge = shellBridge();
  const registry = useContext(RegistryContext);
  const kinds = useAtomValue(notifyKindsAtom);
  const sound = useAtomValue(notifySoundAtom);
  const badge = useAtomValue(notifyBadgeAtom);
  const focused = useSyncExternalStore(onFocusChange, atWindow);
  /** The threads that notified since the user last looked at them. */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const handled = useRef(0);

  const take = useEffectEvent((arrived: ReadonlyArray<Arrived>) => {
    const fresh = arrived.filter((each) => each.seq > handled.current);
    if (fresh.length === 0) return;
    handled.current = fresh.at(-1)!.seq;
    if (bridge?.notify === undefined) return;
    const looking = { atWindow: atWindow(), viewing };
    const counted: Array<string> = [];
    for (const { notification } of fresh) {
      const action = handling(notification, kinds, looking);
      if (action === "ignore") continue;
      counted.push(notification.threadId);
      if (action === "show")
        bridge.notify({
          threadId: notification.threadId,
          title: notification.title,
          body: notificationBody(notification.kind, notification.detail),
          silent: sound === "off",
          attention: notification.kind === "needsYou",
        });
    }
    if (counted.length > 0) setWaiting((current) => new Set([...current, ...counted]));
  });
  // Each notification once, as it arrives, rather than whatever a render happens to see.
  useEffect(
    () =>
      registry.subscribe(notificationsAtom, (result) => {
        if (AsyncResult.isSuccess(result)) take(result.value);
      }),
    [registry],
  );

  // Opening a thread with the window in front of the user is looking at it.
  if (focused && viewing !== undefined && waiting.has(viewing)) {
    const rest = new Set(waiting);
    rest.delete(viewing);
    setWaiting(rest);
  }

  const count = badge === "on" && kinds.length > 0 ? waiting.size : 0;
  const setBadge = bridge?.setBadge;
  useEffect(() => {
    if (setBadge === undefined) return;
    const icon = count > 0 ? drawBadge(count) : undefined;
    setBadge(icon === undefined ? { count } : { count, icon });
  }, [count, setBadge]);
}
