// Keyboard shortcuts as each platform has them. The app spells every shortcut the Windows way, and
// "Ctrl" means the primary modifier: Ctrl on Windows, Linux and the web, ⌘ in the Mac desktop app.
// "Control" means the Control key itself everywhere, for the few shortcuts macOS keeps ⌘ for (⌘M
// minimizes, ⌘` cycles windows, ⌘Tab switches apps). The web client keeps Ctrl on a Mac too: the
// browser holds ⌘N, ⌘T and ⌘W for itself.

/** The modifiers' symbols on a Mac, in the order its menus list them. */
const MAC_MODIFIERS: ReadonlyArray<readonly [string, string]> = [
  ["Control", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Ctrl", "⌘"],
];

const MAC_KEYS: Readonly<Record<string, string>> = { Enter: "↩", Esc: "⎋", Backspace: "⌫" };

/** Whether the shortcuts take ⌘ where they say "Ctrl": the desktop app on a Mac (main.tsx). */
export const usesCommandKey = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset["platform"] === "darwin";

/**
 * `keys` ("Ctrl Shift G") as keycaps, one per key: on a Mac its symbols in the Mac's order (⇧ ⌘ G),
 * elsewhere as written, with "Control" read as Ctrl.
 */
export const keyCapsFor = (keys: string, mac: boolean): ReadonlyArray<string> => {
  const parts = keys.split(" ");
  if (!mac) return parts.map((part) => (part === "Control" ? "Ctrl" : part));
  const modifiers = MAC_MODIFIERS.filter(([name]) => parts.includes(name)).map(([, symbol]) => symbol);
  const rest = parts
    .filter((part) => !MAC_MODIFIERS.some(([name]) => name === part))
    .map((part) => MAC_KEYS[part] ?? part);
  return [...modifiers, ...rest];
};

/**
 * `keys` written inline, as tooltips and menus show it: "Ctrl Shift G" elsewhere, "⇧⌘G" on a Mac,
 * with a space before a key that is a word ("⌘ Click", "⌃ Tab").
 */
export const keyLabelFor = (keys: string, mac: boolean): string => {
  const caps = keyCapsFor(keys, mac);
  if (!mac) return caps.join(" ");
  const modifiers = caps.filter((cap) => MAC_MODIFIERS.some(([, symbol]) => symbol === cap));
  const symbols = modifiers.join("");
  const rest = caps.slice(modifiers.length).join(" ");
  return symbols !== "" && /^[A-Za-z]{3,}/.test(rest) ? `${symbols} ${rest}` : `${symbols}${rest}`;
};

export const keyCaps = (keys: string) => keyCapsFor(keys, usesCommandKey());
export const keyLabel = (keys: string) => keyLabelFor(keys, usesCommandKey());

interface Modifiers {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** Whether `event` holds the primary modifier ("Ctrl") without the other one; Shift and Alt aside. */
export const primaryHeldFor = (event: Modifiers, mac: boolean): boolean =>
  mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

export const primaryHeld = (event: Modifiers) => primaryHeldFor(event, usesCommandKey());
