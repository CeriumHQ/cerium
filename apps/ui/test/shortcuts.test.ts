import { describe, expect, it } from "@effect/vitest";

import {
  conflictsFor,
  defaultBindings,
  eventToBinding,
  matchesBinding,
  matchesFamily,
  normalizeBinding,
  parseBinding,
  SHORTCUTS,
  shortcutDef,
  typesInField,
} from "../src/lib/shortcuts.ts";

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
    for (const id of Object.keys(mac) as ReadonlyArray<keyof typeof mac>) {
      expect(conflictsFor(mac, id, true)).toEqual([]);
    }
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

describe("registry", () => {
  it("gives every shortcut a unique id, a group and a parseable default", () => {
    const ids = SHORTCUTS.map((each) => each.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const each of SHORTCUTS.filter(({ fixed }) => fixed !== true)) {
      expect(parseBinding(each.defaultKeys)).toBeDefined();
    }
    for (const each of SHORTCUTS) {
      expect(["General", "Threads", "Panels", "Tabs"]).toContain(each.group);
      expect(shortcutDef(each.id)).toEqual(each);
    }
  });
});
