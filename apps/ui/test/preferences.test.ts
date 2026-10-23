import { describe, expect, it } from "@effect/vitest";

import { isSendKey, stepScale, textScale } from "../src/features/settings/preferences.ts";

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

describe("textScale", () => {
  it("scales the conversation from its 14px design", () => {
    expect(textScale("default")).toBe(1);
    expect(textScale("larger")).toBeCloseTo(16 / 14);
  });
});
