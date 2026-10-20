import {
  NOTIFICATION_KINDS,
  type AccessMode,
  type NotificationKind,
  type ReasoningEffort,
} from "@cerium/protocol";
import { Atom } from "effect/reactivity";

import { WEB } from "../../backend/target.ts";
import { remember, stored } from "../../lib/storage.ts";
import { accessOptions, effortLabel } from "../composer/models.ts";

// Preferences that only change this window, kept in its local storage. Each is an atom, so the
// settings view and the parts of the window a preference changes stay in step.

const preference = <A extends string>(key: string, options: ReadonlyArray<A>, fallback: A) =>
  Atom.writable(
    () => options.find((option) => option === stored(key)) ?? fallback,
    (context, value: A) => {
      context.setSelf(value);
      remember(key, value);
    },
  ).pipe(Atom.keepAlive);

const MODEL_KEY = "cerium:model";

export type Theme = "system" | "dark" | "light";
export const THEME_KEY = "cerium:theme";
export const themes: ReadonlyArray<Theme> = ["system", "dark", "light"];
/** The desktop is dark until changed; a phone follows its own setting. */
export const themeAtom = preference<Theme>(THEME_KEY, themes, WEB ? "system" : "dark");

/** The conversation's text sizes, smallest first; the transcript scales to match. */
export const textSizes = [
  { id: "small", label: "Small", px: 13 },
  { id: "default", label: "Default", px: 14 },
  { id: "large", label: "Large", px: 15 },
  { id: "larger", label: "Larger", px: 16 },
] as const;
export type TextSize = (typeof textSizes)[number]["id"];
export const textSizeAtom = preference<TextSize>(
  "cerium:textSize",
  textSizes.map((size) => size.id),
  "default",
);
/** How much the conversation is scaled from its 14px design. */
export const textScale = (size: TextSize) => (textSizes.find((each) => each.id === size)?.px ?? 14) / 14;

/** How much the desktop window is scaled, in percent, smallest first: the stops Ctrl + and Ctrl − step through. */
export const scales = [75, 80, 90, 100, 110, 125, 150] as const;
export type Scale = (typeof scales)[number];
const SCALE_KEY = "cerium:scale";
/** 100% until changed. */
export const scaleAtom = Atom.writable(
  (): Scale => scales.find((scale) => String(scale) === stored(SCALE_KEY)) ?? 100,
  (context, value: Scale) => {
    context.setSelf(value);
    remember(SCALE_KEY, String(value));
  },
).pipe(Atom.keepAlive);
/** The scale `by` stops from `scale`, held at the smallest and largest. */
export const stepScale = (scale: Scale, by: number): Scale => {
  const at = Math.min(scales.length - 1, Math.max(0, scales.indexOf(scale) + by));
  return scales[at] ?? 100;
};

/** Which key sends a message; the other way of pressing Enter starts a new line. */
export type SendKey = "enter" | "ctrlEnter";
export const sendKeyAtom = preference<SendKey>("cerium:sendKey", ["enter", "ctrlEnter"], "enter");

/**
 * Whether a key press in a message box sends it. With Enter, Ctrl Enter sends too; with Ctrl Enter,
 * a plain Enter starts a new line. Shift Enter always starts one, and Enter confirming an IME
 * composition never sends.
 */
export const isSendKey = (
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly nativeEvent: { readonly isComposing: boolean };
  },
  sendKey: SendKey,
): boolean =>
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.nativeEvent.isComposing &&
  (sendKey === "enter" || event.ctrlKey);

// The desktop's own notifications about this computer's threads; the web client's are Web Push,
// which the relay keeps.
const NOTIFY_KINDS_KEY = "cerium:notifyKinds";
/** The kinds the desktop shows a notification for; none turns them off. All until changed. */
export const notifyKindsAtom = Atom.writable(
  (): ReadonlyArray<NotificationKind> => {
    const saved = stored(NOTIFY_KINDS_KEY);
    if (saved === undefined) return NOTIFICATION_KINDS;
    const kinds = saved.split(",");
    return NOTIFICATION_KINDS.filter((kind) => kinds.includes(kind));
  },
  (context, kinds: ReadonlyArray<NotificationKind>) => {
    context.setSelf(kinds);
    remember(NOTIFY_KINDS_KEY, kinds.join(","));
  },
).pipe(Atom.keepAlive);
/** Windows plays its notification sound with each one. */
export const notifySoundAtom = preference<"on" | "off">("cerium:notifySound", ["on", "off"], "on");
/** The taskbar icon counts the threads that notified since the user last looked at them. */
export const notifyBadgeAtom = preference<"on" | "off">("cerium:notifyBadge", ["on", "off"], "on");

// What a new thread starts with. The composer offers the same choices and remembers the last one.
/** The chosen model's `modelKey`; the harnesses decide which models exist, so any value is kept. */
export const modelAtom = Atom.writable(
  () => stored(MODEL_KEY) ?? "",
  (context, value: string) => {
    context.setSelf(value);
    remember(MODEL_KEY, value);
  },
).pipe(Atom.keepAlive);
export const effortAtom = preference<ReasoningEffort>(
  "cerium:effort",
  Object.keys(effortLabel) as ReadonlyArray<ReasoningEffort>,
  "high",
);
/**
 * The access every new work thread starts with. Only Settings changes it: a pick in the composer
 * covers the one thread it starts. Kept under a new key, so earlier remembered picks don't carry over.
 */
export const accessAtom = preference<AccessMode>(
  "cerium:defaultAccess",
  accessOptions.map((option) => option.value),
  "auto",
);
/** Where new work threads in a git project run: the project's own folder, or a worktree each, as last picked. */
export const workplaceAtom = preference<"local" | "worktree">(
  "cerium:workplace",
  ["local", "worktree"],
  "local",
);
