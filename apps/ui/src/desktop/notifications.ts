import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { notificationsAtom } from "../backend/atoms.ts";
import {
  cueSoundsAtom,
  notifyBadgeAtom,
  notifyKindsAtom,
  notifySoundAtom,
  themeAtom,
} from "../features/settings/preferences.ts";
import { cueOfBatch, playCue } from "./sounds.ts";

/** Draws the badge icons Windows needs, in the UI's accent, including while the UI is hibernating. */
const drawBadges = (): string[] => {
  const canvas = document.createElement("canvas");
  const size = (canvas.width = canvas.height = 32);
  const context = canvas.getContext("2d");
  if (context === null) return [];
  const probe = document.createElement("span");
  probe.className = "bg-accent text-accent-fg";
  document.body.append(probe);
  const { backgroundColor, color, fontFamily } = getComputedStyle(probe);
  probe.remove();
  return Array.from({ length: 10 }, (_, index) => {
    context.clearRect(0, 0, size, size);
    context.fillStyle = backgroundColor;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = color;
    context.font = `600 ${index === 9 ? 16 : 20}px ${fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(index === 9 ? "9+" : String(index + 1), size / 2, size / 2 + 1);
    return canvas.toDataURL("image/png");
  });
};

/** The shell shows toasts and maintains the badge. The window supplies its preferences and plays cues. */
export function useDesktopNotifications(main: boolean, viewing: string | undefined) {
  const bridge = window.cerium;
  const registry = useContext(RegistryContext);
  const kinds = useAtomValue(notifyKindsAtom);
  const sound = useAtomValue(notifySoundAtom);
  const badge = useAtomValue(notifyBadgeAtom);
  const cues = useAtomValue(cueSoundsAtom);
  const theme = useAtomValue(themeAtom);

  useEffect(() => {
    if (main) bridge?.notificationPreferences?.({ kinds, silent: sound === "off", badge: badge === "on" });
  }, [main, bridge, kinds, sound, badge]);
  useEffect(() => {
    if (main) bridge?.notificationViewing?.(viewing);
  }, [main, bridge, viewing]);
  useEffect(() => {
    if (!main || bridge?.platform !== "win32") return;
    const frame = requestAnimationFrame(() => bridge.notificationBadgeIcons?.(drawBadges()));
    return () => cancelAnimationFrame(frame);
  }, [main, bridge, theme]);

  useEffect(() => {
    if (!main || bridge === undefined || cues !== "on") return;
    let handled = 0;
    return registry.subscribe(notificationsAtom, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const fresh = result.value.filter((each) => each.seq > handled);
      if (fresh.length === 0) return;
      handled = fresh.at(-1)!.seq;
      const cue = cueOfBatch(fresh.map((each) => each.notification.kind));
      if (cue !== undefined) playCue(cue);
    });
  }, [main, bridge, cues, registry]);
}
