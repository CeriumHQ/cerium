// Every keyboard shortcut in one registry. Settings → Keyboard lists these, grouped and
// searchable, and lets the user rebind each one; the command palette, tooltips and every key
// handler read the same bindings, so a rebind holds everywhere. The app spells every shortcut
// the Windows way ("Ctrl" being the primary modifier); lib/keys.ts renders it for the platform.
//
// To add a shortcut for a new action: add an entry to `SHORTCUTS` with its default keys, read
// it with `useShortcut(id)` (or `bindingFor` outside React), show it with `keyLabel`, and match
// presses with `matchesBinding`. `SHORTCUT_IDS` lists every id.

import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { usesCommandKey } from "./keys.ts";
import { remember, stored } from "./storage.ts";

export const SHORTCUT_GROUPS = ["General", "Threads", "Panels", "Tabs"] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface ShortcutDef {
  /** Stable id, kept in storage. */
  readonly id: string;
  /** What Settings → Keyboard names it. */
  readonly label: string;
  readonly group: ShortcutGroup;
  /** The default keys, spelled as lib/keys.ts reads them ("Ctrl Shift G"). */
  readonly defaultKeys: string;
  /**
   * The default in the Mac desktop app, where "Ctrl" is ⌘, when `defaultKeys` would land on keys
   * macOS keeps for itself (⌘⇧3 takes a screenshot) or types with (⌥3 is `#` on a British layout).
   */
  readonly macKeys?: string;
  /** Shown instead of the keys where one binding stands for several (digit families). */
  readonly displayKeys?: string;
  /** Other words that find it in Settings → Keyboard. */
  readonly keywords?: string;
  /**
   * A family: the binding names the modifiers, and any digit completes it (`open-thread-row`
   * opens the row for the digit pressed). `digit` takes 0–9, `digit19` takes 1–9.
   */
  readonly family?: "digit" | "digit19";
  /** Shown but not rebound (the mouse has no keys to press). */
  readonly fixed?: boolean;
}

const def = (
  id: string,
  label: string,
  group: ShortcutGroup,
  defaultKeys: string,
  extra?: Partial<ShortcutDef>,
): ShortcutDef => ({ id, label, group, defaultKeys, ...extra });

/**
 * Every shortcut. A new action with a shortcut adds its entry here (and only here for its
 * default); handlers match with `matchesBinding`, UI shows with `useShortcut` + `keyLabel`.
 */
export const SHORTCUTS: ReadonlyArray<ShortcutDef> = [
  def("command-palette", "Search threads, or run a command", "General", "Ctrl K", {
    keywords: "palette find commands",
  }),
  def("open-settings", "Open or close settings", "General", "Ctrl ,", { keywords: "preferences" }),
  def("stop-all", "Stop everything", "General", "Ctrl Shift .", {
    keywords: "interrupt cancel halt agents approvals",
  }),
  def("dictate", "Start or stop dictating in the message box", "General", "Control M", {
    keywords: "microphone speech voice",
  }),
  def("switch-to-work", "Switch to Work", "General", "Ctrl Shift 1", { keywords: "mode home" }),
  def("switch-to-chat", "Switch to Chat", "General", "Ctrl Shift 2", { keywords: "mode" }),
  def("open-tasks", "Open tasks", "General", "Ctrl Shift 3", {
    keywords: "todo list rail",
    macKeys: "Ctrl Alt 3",
  }),
  def("open-github", "Open GitHub", "General", "Ctrl Shift 4", {
    keywords: "pull requests issues rail",
    macKeys: "Ctrl Alt 4",
  }),
  def("open-automations", "Open automations", "General", "Ctrl Shift 5", {
    keywords: "schedule trigger cron rail",
    macKeys: "Ctrl Alt 5",
  }),
  def("zoom-in", "Make everything larger", "General", "Ctrl +", { keywords: "zoom scale bigger" }),
  def("zoom-out", "Make everything smaller", "General", "Ctrl −", { keywords: "zoom scale" }),
  def("zoom-reset", "Back to 100%", "General", "Ctrl Num0", { keywords: "zoom scale reset" }),
  def("new-thread", "New thread", "Threads", "Ctrl N", { keywords: "new chat compose" }),
  def("find-in-thread", "Find in the thread", "Threads", "Ctrl F", {
    keywords: "search messages transcript",
  }),
  def("open-thread-row", "Open the sidebar's first ten threads", "Threads", "Ctrl 1", {
    displayKeys: "Ctrl 1–0",
    keywords: "sidebar list rows digits",
    family: "digit",
  }),
  def("toggle-sidebar", "Show or hide the sidebar", "Panels", "Ctrl B", { keywords: "threads list" }),
  def("toggle-agents", "Show or hide the thread's agents", "Panels", "Ctrl J", {
    keywords: "inspector",
  }),
  def("toggle-files", "Show or hide files", "Panels", "Ctrl Shift E", { keywords: "explorer tree" }),
  def("toggle-source-control", "Show or hide source control", "Panels", "Ctrl Shift G", {
    keywords: "git changes stage commit",
  }),
  def("toggle-github-panel", "Show or hide GitHub", "Panels", "Ctrl Shift H", {
    keywords: "pull requests issues reviews",
  }),
  def("toggle-terminal", "Show, focus or hide the terminal", "Panels", "Control `", {
    keywords: "shell console",
  }),
  def("new-tab", "New thread in a tab", "Tabs", "Ctrl T", { keywords: "tabs" }),
  def("close-tab", "Close the tab", "Tabs", "Ctrl W", { keywords: "tabs" }),
  def("reopen-tab", "Reopen the tab closed last", "Tabs", "Ctrl Shift T", { keywords: "tabs undo" }),
  def("next-tab", "Next tab", "Tabs", "Control Tab", { keywords: "tabs step" }),
  def("previous-tab", "Previous tab", "Tabs", "Control Shift Tab", { keywords: "tabs step back" }),
  def("go-to-tab", "Go to a tab, 9 being the last", "Tabs", "Alt 1", {
    displayKeys: "Alt 1–9",
    macKeys: "Control 1",
    keywords: "tabs digits",
    family: "digit19",
  }),
  def("split-right", "New thread to the right", "Tabs", "Ctrl \\", {
    keywords: "split pane beside",
  }),
  def("split-below", "New thread below", "Tabs", "Ctrl Shift \\", { keywords: "split pane" }),
  def("move-tab-left", "Move the tab left", "Tabs", "Control Shift PgUp", { keywords: "tabs move" }),
  def("move-tab-right", "Move the tab right", "Tabs", "Control Shift PgDn", {
    keywords: "tabs move",
  }),
  def("open-in-tab", "Open a sidebar thread in a tab of its own", "Tabs", "Ctrl Click", {
    keywords: "tabs mouse",
    fixed: true,
  }),
  def("cancel", "Stop the running turn, or leave settings", "General", "Esc", {
    keywords: "escape close leave",
    fixed: true,
  }),
];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const byId = new Map(SHORTCUTS.map((each) => [each.id, each]));
export const shortcutDef = (id: string): ShortcutDef | undefined => byId.get(id);

/** A shortcut's default keys on this platform: its Mac ones in the Mac desktop app. */
export const defaultKeysOf = (each: ShortcutDef, mac = usesCommandKey()): string =>
  (mac ? each.macKeys : undefined) ?? each.defaultKeys;

/** The bindings with nothing rebound. */
export const defaultBindings = (mac = usesCommandKey()): Record<ShortcutId, string> =>
  Object.fromEntries(SHORTCUTS.map((each) => [each.id, defaultKeysOf(each, mac)])) as Record<
    ShortcutId,
    string
  >;

const STORAGE_KEY = "cerium:shortcuts:v1";

const readOverrides = (): Partial<Record<ShortcutId, string>> => {
  try {
    const parsed: unknown = JSON.parse(stored(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    const overrides: Partial<Record<ShortcutId, string>> = {};
    for (const [id, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof keys === "string" && byId.has(id) && parseBinding(keys) !== undefined) {
        overrides[id as ShortcutId] = keys;
      }
    }
    return overrides;
  } catch {
    return {};
  }
};

/** Every shortcut's keys, defaults with the user's rebinds over them. Kept in this window's storage. */
export const shortcutBindingsAtom: Atom.Writable<Record<ShortcutId, string>> = Atom.writable(
  (): Record<ShortcutId, string> => {
    const merged = defaultBindings();
    const overrides = readOverrides();
    for (const id of Object.keys(merged) as ReadonlyArray<ShortcutId>) {
      const next = overrides[id];
      if (next !== undefined) merged[id] = next;
    }
    return merged;
  },
  (context, value: Record<ShortcutId, string>) => {
    context.setSelf(value);
    const defaults = defaultBindings();
    const overrides = Object.fromEntries(
      (Object.entries(value) as ReadonlyArray<[ShortcutId, string]>).filter(
        ([id, keys]) => keys !== defaults[id],
      ),
    );
    remember(STORAGE_KEY, JSON.stringify(overrides));
  },
).pipe(Atom.keepAlive);

/** One shortcut's keys outside React, from the bindings map. */
export const bindingFor = (bindings: Record<ShortcutId, string>, id: ShortcutId): string =>
  bindings[id] ?? (byId.has(id) ? defaultKeysOf(byId.get(id) as ShortcutDef) : "");

/** One shortcut's keys in React, following the user's rebinds. */
export const useShortcut = (id: ShortcutId): string => bindingFor(useAtomValue(shortcutBindingsAtom), id);

/**
 * While Settings → Keyboard listens for a rebind, every key handler asks this first and stands
 * down, so the press being learned doesn't also run what it currently does.
 */
let capturingBinding = false;
export const isCapturingBinding = (): boolean => capturingBinding;
export const setCapturingBinding = (capturing: boolean): void => {
  capturingBinding = capturing;
};

/** The ids bound to the same keys (normalized for this platform), besides `id` itself. */
export const conflictsFor = (
  bindings: Record<ShortcutId, string>,
  id: ShortcutId,
  mac = false,
): ReadonlyArray<ShortcutId> => {
  const keys = normalizeBinding(bindings[id] ?? "", mac);
  if (keys === undefined) return [];
  return (Object.keys(bindings) as ReadonlyArray<ShortcutId>).filter(
    (other) => other !== id && normalizeBinding(bindings[other] ?? "", mac) === keys,
  );
};

interface ParsedBinding {
  /** The primary modifier ("Ctrl"): ⌘ on a Mac, Ctrl elsewhere. */
  readonly primary: boolean;
  /** The Control key itself, everywhere (⌃ on a Mac, which keeps ⌘ for itself). */
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** The key after the modifiers, as written ("G", "`", "Tab", "1", "+", "−", "Num0", ...). */
  readonly key: string;
}

/** `binding` ("Ctrl Shift G") split into its modifiers and key; undefined when not well formed. */
export const parseBinding = (binding: string): ParsedBinding | undefined => {
  const parts = binding
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  const key = parts[parts.length - 1] as string;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (["ctrl", "control", "alt", "shift"].includes(key.toLowerCase())) return undefined;
  if (modifiers.length !== new Set(modifiers).size) return undefined;
  if (modifiers.some((part) => !["ctrl", "control", "alt", "shift"].includes(part))) return undefined;
  return {
    primary: modifiers.includes("ctrl"),
    control: modifiers.includes("control"),
    alt: modifiers.includes("alt"),
    shift: modifiers.includes("shift"),
    key,
  };
};

/**
 * `binding` in canonical form (modifiers ordered, key uppercased where it is a letter). Off a Mac,
 * "Control" is the same physical chord as "Ctrl", so they normalize together there.
 */
export const normalizeBinding = (binding: string, mac = false): string | undefined => {
  const parsed = parseBinding(binding);
  if (parsed === undefined) return undefined;
  const primary = parsed.primary || (!mac && parsed.control);
  const control = mac && parsed.control;
  const modifiers = [
    ...(primary ? ["Ctrl"] : []),
    ...(control ? ["Control"] : []),
    ...(parsed.alt ? ["Alt"] : []),
    ...(parsed.shift ? ["Shift"] : []),
  ];
  return [...modifiers, canonicalKey(parsed.key)].join(" ");
};

const canonicalKey = (key: string): string =>
  key.length === 1 ? key.toUpperCase() : key.toLowerCase() === "escape" ? "Esc" : key;

interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Whether a press holds the primary modifier ("Ctrl") without the other one; Shift and Alt aside. */
const primaryHeld = (event: KeyPress, mac: boolean): boolean =>
  mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * Whether `event` presses `binding`. Families match any of their digits; "+" also answers "=" (the
 * key it shares), "−" answers "-" and "_", and digits compare by position so layouts don't matter.
 */
export const matchesBinding = (event: KeyPress, binding: string, mac: boolean): boolean => {
  const parsed = parseBinding(binding);
  if (parsed === undefined || parsed.key.toLowerCase() === "click") return false;
  if (parsed.primary && !(mac ? event.metaKey : event.ctrlKey)) return false;
  if (parsed.primary && (mac ? event.ctrlKey : event.metaKey)) return false;
  if (parsed.control && !event.ctrlKey) return false;
  // "Control" never takes ⌘/⊞ with it: off a Mac it is the Ctrl key itself.
  if (parsed.control && !parsed.primary && event.metaKey) return false;
  if (!parsed.primary && !parsed.control && event.ctrlKey) return false;
  if (!parsed.primary && mac && event.metaKey) return false;
  if (!parsed.primary && !mac && !parsed.control && event.metaKey) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift && !shiftFreeKey(parsed.key)) return false;
  return matchKey(parsed.key, event);
};

/** The "+" and "−" keys answer their unshifted partner too, as the zoom handler always has. */
const shiftFreeKey = (key: string): boolean => key === "+" || key === "−";

const matchKey = (token: string, event: KeyPress): boolean => {
  if (/^[0-9]$/.test(token)) return event.code === `Digit${token}`;
  if (token === "Num0") return event.code === "Numpad0";
  if (token === "Tab") return event.key === "Tab";
  if (token === "Enter") return event.key === "Enter";
  if (token === "Esc" || token.toLowerCase() === "escape") return event.key === "Escape";
  if (token === "Backspace") return event.key === "Backspace";
  if (token === "Delete") return event.key === "Delete";
  if (token === "Space") return event.key === " ";
  if (token === "PgUp") return event.key === "PageUp";
  if (token === "PgDn") return event.key === "PageDown";
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) return event.key === token;
  if (token === "`") return event.code === "Backquote";
  if (token === "\\") return event.code === "Backslash";
  if (token === ".") return event.code === "Period";
  if (token === ",") return event.code === "Comma";
  if (token === "/") return event.code === "Slash";
  if (token === "'") return event.code === "Quote";
  if (token === "+") return event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
  if (token === "−") return event.key === "-" || event.key === "_" || event.code === "NumpadSubtract";
  if (token.length === 1) return event.key.length === 1 && event.key.toLowerCase() === token.toLowerCase();
  return false;
};

/**
 * Whether `event` presses a digit of the family `binding` names (any of 0–9, or 1–9), with the
 * binding's modifiers. Which digit is the handler's own business.
 */
export const matchesFamily = (event: KeyPress, binding: string, mac: boolean): boolean => {
  const parsed = parseBinding(binding);
  if (parsed === undefined) return false;
  if (parsed.primary && !primaryHeld(event, mac)) return false;
  if (parsed.control && (!event.ctrlKey || event.metaKey)) return false;
  if (!parsed.primary && !parsed.control && (event.ctrlKey || event.metaKey)) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  return /^Digit[0-9]$/.test(event.code);
};

/**
 * Whether `event` types a character into a text field rather than pressing a shortcut: Alt alone
 * with a key that writes something other than itself, as a Mac's Option layer does (⌥3 is `#` on a
 * British layout, `[` is ⌥5 on a German one). Elsewhere Alt with a digit writes the digit, or
 * nothing.
 */
export const typesInField = (event: KeyPress, inField: boolean): boolean =>
  inField &&
  event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  event.key.length === 1 &&
  !/^[0-9]$/.test(event.key);

/** Whether `target` takes typing: a text field, or editable content such as the message box. */
export const isField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea"));

/**
 * The binding `event` would set, spelled canonically ("Ctrl Shift G"), or undefined when the press
 * can't be a shortcut: bare keys (typing must keep them), modifiers alone, the mouse, and ⌘/Ctrl
 * pairs off a Mac that the OS keeps. Esc captures as "Esc".
 */
export const eventToBinding = (event: KeyPress, mac: boolean): string | undefined => {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return undefined;
  if (event.key === "Escape") return "Esc";
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const control = mac ? event.ctrlKey : false;
  if (!primary && !control && !event.altKey) return undefined;
  if (!mac && event.metaKey) return undefined;
  const key = keyToken(event);
  if (key === undefined) return undefined;
  if (key === "Click") return undefined;
  const modifiers = [
    ...(primary ? ["Ctrl"] : []),
    ...(control ? ["Control"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
  ];
  return [...modifiers, key].join(" ");
};

const keyToken = (event: KeyPress): string | undefined => {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  switch (code) {
    case "Backquote":
      return "`";
    case "Backslash":
      return "\\";
    case "Period":
      return ".";
    case "Comma":
      return ",";
    case "Slash":
      return "/";
    case "Quote":
      return "'";
    case "Minus":
      return "−";
    case "Equal":
      return "+";
    case "NumpadAdd":
      return "+";
    case "NumpadSubtract":
      return "−";
    case "Numpad0":
      return "Num0";
    case "Tab":
      return "Tab";
    case "Enter":
      return "Enter";
    case "Space":
      return "Space";
    case "PageUp":
      return "PgUp";
    case "PageDown":
      return "PgDn";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    default:
      break;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key;
  return undefined;
};
