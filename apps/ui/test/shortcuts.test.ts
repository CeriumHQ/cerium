import { describe, expect, it } from "@effect/vitest";

import { keyLabelFor } from "../src/lib/keys.ts";
import {
  conflictsFor,
  defaultBindings,
  eventToBinding,
  matchesBinding,
  matchesFamily,
  normalizeBinding,
  parseBinding,
  SHORTCUTS,
  typesInField,
} from "../src/lib/shortcuts.ts";
import { isSendKey } from "../src/features/settings/preferences.ts";

const press = (
  key: string,
  code: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
) => ({
  key,
  code,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: modifiers.meta ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
});

describe("parseBinding", () => {
  it("splits modifiers from the key", () => {
    expect(parseBinding("Ctrl Shift G")).toEqual({
      primary: true,
      control: false,
      alt: false,
      shift: true,
      key: "G",
    });
    expect(parseBinding("Control `")).toEqual({
      primary: false,
      control: true,
      alt: false,
      shift: false,
      key: "`",
    });
    expect(parseBinding("Esc")).toEqual({
      primary: false,
      control: false,
      alt: false,
      shift: false,
      key: "Esc",
    });
  });

  it("rejects what cannot be a shortcut", () => {
    expect(parseBinding("")).toBeUndefined();
    expect(parseBinding("Ctrl")).toBeUndefined();
    expect(parseBinding("Ctrl Ctrl G")).toBeUndefined();
    expect(parseBinding("Cmd G")).toBeUndefined();
  });
});

describe("normalizeBinding", () => {
  it("orders modifiers and uppercases letters", () => {
    expect(normalizeBinding("Shift Ctrl g")).toBe("Ctrl Shift G");
    expect(normalizeBinding("Ctrl Shift G")).toBe("Ctrl Shift G");
    expect(normalizeBinding("Esc")).toBe("Esc");
  });
});

describe("matchesBinding", () => {
  it("takes Ctrl off a Mac and ⌘ on one, never both", () => {
    expect(matchesBinding(press("n", "KeyN", { ctrl: true }), "Ctrl N", false)).toBe(true);
    expect(matchesBinding(press("n", "KeyN", { meta: true }), "Ctrl N", false)).toBe(false);
    expect(matchesBinding(press("n", "KeyN", { meta: true }), "Ctrl N", true)).toBe(true);
    expect(matchesBinding(press("n", "KeyN", { ctrl: true }), "Ctrl N", true)).toBe(false);
    expect(matchesBinding(press("n", "KeyN", { ctrl: true, meta: true }), "Ctrl N", true)).toBe(false);
  });

  it("keeps Control on the Control key itself, everywhere", () => {
    expect(matchesBinding(press("`", "Backquote", { ctrl: true }), "Control `", false)).toBe(true);
    expect(matchesBinding(press("`", "Backquote", { ctrl: true }), "Control `", true)).toBe(true);
    expect(matchesBinding(press("`", "Backquote", { meta: true }), "Control `", true)).toBe(false);
  });

  it("compares digits and punctuation by position, not layout", () => {
    expect(matchesBinding(press("é", "Digit1", { ctrl: true }), "Ctrl 1", false)).toBe(true);
    expect(matchesBinding(press("\\", "Backslash", { ctrl: true }), "Ctrl \\", false)).toBe(true);
    expect(matchesBinding(press(".", "Period", { ctrl: true, shift: true }), "Ctrl Shift .", false)).toBe(
      true,
    );
    expect(matchesBinding(press(",", "Comma", { ctrl: true }), "Ctrl ,", false)).toBe(true);
  });

  it("answers the zoom keys with or without Shift, as before", () => {
    expect(matchesBinding(press("=", "Equal", { ctrl: true }), "Ctrl +", false)).toBe(true);
    expect(matchesBinding(press("+", "Equal", { ctrl: true, shift: true }), "Ctrl +", false)).toBe(true);
    expect(matchesBinding(press("-", "Minus", { ctrl: true }), "Ctrl −", false)).toBe(true);
    expect(matchesBinding(press("_", "Minus", { ctrl: true, shift: true }), "Ctrl −", false)).toBe(true);
    expect(matchesBinding(press("0", "Numpad0", { ctrl: true }), "Ctrl Num0", false)).toBe(true);
  });

  it("never matches the mouse or the other modifier's chord", () => {
    expect(matchesBinding(press("x", "KeyX", { ctrl: true }), "Ctrl Click", false)).toBe(false);
    expect(matchesBinding(press("g", "KeyG", { ctrl: true, alt: true }), "Ctrl G", false)).toBe(false);
    expect(matchesBinding(press("m", "KeyM", { ctrl: true, meta: true }), "Control M", false)).toBe(false);
  });

  it("reads Control as Ctrl off a Mac, where it is the same chord", () => {
    expect(matchesBinding(press("m", "KeyM", { ctrl: true }), "Control M", false)).toBe(true);
    expect(normalizeBinding("Control M")).toBe("Ctrl M");
    expect(normalizeBinding("Control M", true)).toBe("Control M");
  });
});

describe("matchesFamily", () => {
  it("matches any digit with the family's modifiers", () => {
    expect(matchesFamily(press("5", "Digit5", { ctrl: true }), "Ctrl 1", false)).toBe(true);
    expect(matchesFamily(press("0", "Digit0", { ctrl: true }), "Ctrl 1", false)).toBe(true);
    expect(matchesFamily(press("5", "Digit5", {}), "Ctrl 1", false)).toBe(false);
    expect(matchesFamily(press("5", "Digit5", { alt: true }), "Alt 1", false)).toBe(true);
    expect(matchesFamily(press("a", "KeyA", { alt: true }), "Alt 1", false)).toBe(false);
  });
});

describe("eventToBinding", () => {
  it("spells a press canonically", () => {
    expect(eventToBinding(press("g", "KeyG", { ctrl: true, shift: true }), false)).toBe("Ctrl Shift G");
    expect(eventToBinding(press("m", "KeyM", { ctrl: true }), false)).toBe("Ctrl M");
    expect(eventToBinding(press("m", "KeyM", { ctrl: true }), true)).toBe("Control M");
    expect(eventToBinding(press("n", "KeyN", { meta: true }), true)).toBe("Ctrl N");
    expect(eventToBinding(press("Escape", "Escape", {}), false)).toBe("Esc");
    expect(eventToBinding(press("0", "Numpad0", { ctrl: true }), false)).toBe("Ctrl Num0");
  });

  it("captures and matches a modified arrow on both platforms", () => {
    for (const mac of [false, true]) {
      for (const arrow of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        const event = press(arrow, arrow, { alt: true });
        expect(eventToBinding(event, mac)).toBe(`Alt ${arrow}`);
        expect(matchesBinding(event, `Alt ${arrow}`, mac)).toBe(true);
        expect(matchesBinding(press(arrow, arrow), `Alt ${arrow}`, mac)).toBe(false);
        expect(eventToBinding(press(arrow, arrow), mac)).toBeUndefined();
      }
    }
    expect(keyLabelFor("Alt ArrowUp", false)).toBe("Alt ↑");
    expect(keyLabelFor("Alt ArrowUp", true)).toBe("⌥↑");
    expect(keyLabelFor("Alt ArrowDown", false)).toBe("Alt ↓");
    expect(keyLabelFor("Alt ArrowDown", true)).toBe("⌥↓");
  });

  it("refuses bare keys, modifiers alone and the OS's own chords", () => {
    expect(eventToBinding(press("g", "KeyG", {}), false)).toBeUndefined();
    expect(eventToBinding(press("Control", "ControlLeft", { ctrl: true }), false)).toBeUndefined();
    expect(eventToBinding(press("n", "KeyN", { meta: true }), false)).toBeUndefined();
  });
});

describe("conflictsFor", () => {
  it("finds the shortcuts bound to the same keys", () => {
    const bindings = { ...defaultBindings(), "toggle-sidebar": "Ctrl N" };
    expect(conflictsFor(bindings, "toggle-sidebar")).toEqual(["new-thread"]);
    expect(conflictsFor(bindings, "new-thread")).toEqual(["toggle-sidebar"]);
    expect(conflictsFor(defaultBindings(), "new-thread")).toEqual([]);
    const aliased = { ...defaultBindings(), "toggle-sidebar": "Ctrl M" };
    expect(conflictsFor(aliased, "toggle-sidebar")).toEqual(["dictate"]);
  });
});

describe("defaultBindings", () => {
  it("keeps the Mac app off keys macOS keeps or types with", () => {
    const windows = defaultBindings(false);
    const mac = defaultBindings(true);
    expect(windows["go-to-tab"]).toBe("Alt 1");
    expect(mac["go-to-tab"]).toBe("Control 1");
    expect(windows["open-tasks"]).toBe("Ctrl Shift 3");
    expect(mac["open-tasks"]).toBe("Ctrl Alt 3");
    expect(mac["new-thread"]).toBe(windows["new-thread"]);
  });

  it.each([false, true])("has no normalized or physical default conflicts (Mac %s)", (mac) => {
    const bindings = defaultBindings(mac);
    const keys = new Map<string, string>([
      ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (key) => [`Key${key}`, key.toLowerCase()] as const),
      ...Array.from("0123456789", (key) => [`Digit${key}`, key] as const),
      ...["Enter", "Tab", "Escape", "PageUp", "PageDown", "ArrowUp", "ArrowDown"].map(
        (key) => [key, key] as const,
      ),
      ["Comma", ","],
      ["Slash", "/"],
      ["Period", "."],
      ["Backslash", "\\"],
      ["Backquote", "`"],
      ["Equal", "="],
      ["Minus", "-"],
      ["NumpadAdd", "+"],
      ["NumpadSubtract", "-"],
      ["Numpad0", "0"],
    ]);
    const seen = new Set<string>();
    const conflicts: Array<{ code: string; mask: number; ids: ReadonlyArray<string> }> = [];
    for (const [code, key] of keys) {
      for (let mask = 0; mask < 16; mask++) {
        const event = press(key, code, {
          ctrl: (mask & 1) !== 0,
          meta: (mask & 2) !== 0,
          alt: (mask & 4) !== 0,
          shift: (mask & 8) !== 0,
        });
        const matched = SHORTCUTS.filter(({ id, family }) =>
          family === undefined
            ? matchesBinding(event, bindings[id]!, mac)
            : (family === "digit" || code !== "Digit0") && matchesFamily(event, bindings[id]!, mac),
        );
        if (matched.length > 1) conflicts.push({ code, mask, ids: matched.map(({ id }) => id) });
        for (const { id } of matched) seen.add(id);
      }
    }
    expect(conflicts).toEqual([]);
    expect(seen).toEqual(new Set(SHORTCUTS.filter(({ id }) => id !== "open-in-tab").map(({ id }) => id)));
    for (const { id } of SHORTCUTS) {
      expect(conflictsFor(bindings, id, mac)).toEqual([]);
    }
    expect(Object.keys(bindings)).toHaveLength(SHORTCUTS.length);
  });

  it.each([false, true])("keeps steer-now apart from both send preferences (Mac %s)", (mac) => {
    const event = {
      ...press("Enter", "Enter", { ctrl: !mac, meta: mac, shift: true }),
      nativeEvent: { isComposing: false },
    };
    expect(matchesBinding(event, defaultBindings(mac)["steer-now"]!, mac)).toBe(true);
    expect(isSendKey(event, "enter")).toBe(false);
    expect(isSendKey(event, "ctrlEnter")).toBe(false);
  });
});

describe("typesInField", () => {
  it("leaves an Option-layer character to the field", () => {
    expect(typesInField(press("#", "Digit3", { alt: true }), true)).toBe(true);
  });
  it("takes the press outside a field, or when Alt writes the digit", () => {
    expect(typesInField(press("#", "Digit3", { alt: true }), false)).toBe(false);
    expect(typesInField(press("3", "Digit3", { alt: true }), true)).toBe(false);
    expect(typesInField(press("3", "Digit3", { ctrl: true }), true)).toBe(false);
  });
});
