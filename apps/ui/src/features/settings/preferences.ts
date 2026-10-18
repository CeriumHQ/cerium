import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
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
export const accessAtom = preference<AccessMode>(
  "cerium:access",
  accessOptions.map((option) => option.value),
  "ask",
);
