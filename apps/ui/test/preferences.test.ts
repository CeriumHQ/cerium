import { describe, expect, it } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";

import { inboxCapAtom, isSendKey, stepScale } from "../src/features/settings/preferences.ts";

describe("Inbox cap preference", () => {
  it("defaults to 8, persists supported caps and Off, and falls back for invalid storage", () => {
    const storage = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      const registry = AtomRegistry.make();
      expect(registry.get(inboxCapAtom)).toBe(8);
      registry.set(inboxCapAtom, 20);
      expect(AtomRegistry.make().get(inboxCapAtom)).toBe(20);
      registry.set(inboxCapAtom, 0);
      expect(AtomRegistry.make().get(inboxCapAtom)).toBe(0);
      storage.set("cerium:inboxCap", "invalid");
      expect(AtomRegistry.make().get(inboxCapAtom)).toBe(8);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("stepScale", () => {
  it("steps through the stops and holds at either end", () => {
    expect(stepScale(100, 1)).toBe(110);
    expect(stepScale(100, -1)).toBe(90);
    expect(stepScale(150, 1)).toBe(150);
    expect(stepScale(75, -1)).toBe(75);
  });
});

const press = (key: string, modifiers: { shift?: boolean; ctrl?: boolean; composing?: boolean } = {}) => ({
  key,
  shiftKey: modifiers.shift ?? false,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: false,
  nativeEvent: { isComposing: modifiers.composing ?? false },
});

describe("isSendKey", () => {
  it("sends on Enter or Ctrl Enter when Enter sends", () => {
    expect(isSendKey(press("Enter"), "enter")).toBe(true);
    expect(isSendKey(press("Enter", { ctrl: true }), "enter")).toBe(true);
    expect(isSendKey(press("Enter", { shift: true }), "enter")).toBe(false);
  });

  it("leaves a plain Enter for new lines when Ctrl Enter sends", () => {
    expect(isSendKey(press("Enter"), "ctrlEnter")).toBe(false);
    expect(isSendKey(press("Enter", { ctrl: true }), "ctrlEnter")).toBe(true);
    expect(isSendKey(press("Enter", { ctrl: true, shift: true }), "ctrlEnter")).toBe(false);
  });

  it("never sends other keys, or the Enter that confirms an IME composition", () => {
    expect(isSendKey(press("a", { ctrl: true }), "ctrlEnter")).toBe(false);
    expect(isSendKey(press("Enter", { composing: true }), "enter")).toBe(false);
  });
});
