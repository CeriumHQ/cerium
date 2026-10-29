import {
  NOTIFICATION_KINDS,
  type AccessMode,
  type ModelSpeed,
  type NotificationKind,
  type ReasoningEffort,
} from "@cerium/protocol";
import { Atom } from "effect/reactivity";

import { WEB } from "../../backend/target.ts";
import { primaryHeld } from "../../lib/keys.ts";
import { remember, stored } from "../../lib/storage.ts";
import { accessOptions, effortLabel, speedLabel } from "../composer/models.ts";

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

const SOLID_KEY = "cerium:windowSolid";
/**
 * How solid the window is, in percent, for those who don't want the system's glass (Acrylic on Windows,
 * Vibrancy on macOS) showing through: 0 keeps the theme's own glass, 100 hides the desktop entirely.
 */
export const windowSolidAtom = Atom.writable(
  (): number => {
    const value = Number(stored(SOLID_KEY));
    return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
  },
  (context, value: number) => {
    context.setSelf(value);
    remember(SOLID_KEY, String(value));
  },
).pipe(Atom.keepAlive);

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
    readonly metaKey: boolean;
    readonly nativeEvent: { readonly isComposing: boolean };
  },
  sendKey: SendKey,
): boolean =>
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.nativeEvent.isComposing &&
  (sendKey === "enter" || primaryHeld(event));

// The desktop's own notifications about this computer's threads; the web client's are Web Push,
// which the relay keeps.
// Usage limit warnings came after the other kinds, so the choice is kept under a new key: what the
// old one held carries over with the warnings on, rather than silently off.
const NOTIFY_KINDS_KEY = "cerium:notifyKinds:v2";
const LEGACY_NOTIFY_KINDS_KEY = "cerium:notifyKinds";
/** The kinds the desktop shows a notification for; none turns them off. All until changed. */
export const notifyKindsAtom = Atom.writable(
  (): ReadonlyArray<NotificationKind> => {
    const saved = stored(NOTIFY_KINDS_KEY);
    const legacy = stored(LEGACY_NOTIFY_KINDS_KEY);
    // A legacy choice of none was turning every notification off, the warnings too.
    const kinds = saved ?? (legacy === undefined ? undefined : legacy === "" ? "" : `${legacy},limit`);
    if (kinds === undefined) return NOTIFICATION_KINDS;
    const chosen = kinds.split(",");
    return NOTIFICATION_KINDS.filter((kind) => chosen.includes(kind));
  },
  (context, kinds: ReadonlyArray<NotificationKind>) => {
    context.setSelf(kinds);
    remember(NOTIFY_KINDS_KEY, kinds.join(","));
  },
).pipe(Atom.keepAlive);
/** Windows plays its notification sound with each one. */
export const notifySoundAtom = preference<"on" | "off">("cerium:notifySound", ["on", "off"], "on");
/**
 * Cerium plays its own short sound when a thread finishes, needs the user or fails, in front of the
 * window too. Off until chosen.
 */
export const cueSoundsAtom = preference<"on" | "off">("cerium:cueSounds", ["on", "off"], "off");
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
const SPEED_KEY = "cerium:speed";
/**
 * The speed new threads start at, once one is picked; until then each model runs at its harness's own
 * default, as the user configured it there.
 */
export const speedAtom = Atom.writable(
  (): ModelSpeed | undefined =>
    (Object.keys(speedLabel) as ReadonlyArray<ModelSpeed>).find((speed) => speed === stored(SPEED_KEY)),
  (context, value: ModelSpeed) => {
    context.setSelf(value);
    remember(SPEED_KEY, value);
  },
).pipe(Atom.keepAlive);
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
