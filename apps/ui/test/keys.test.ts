import { describe, expect, it } from "@effect/vitest";

import { keyLabelFor, primaryHeldFor } from "../src/lib/keys.ts";

describe("keyLabelFor", () => {
  it("writes shortcuts as they are spelled off a Mac, with Control read as Ctrl", () => {
    expect(keyLabelFor("Ctrl Shift G", false)).toBe("Ctrl Shift G");
    expect(keyLabelFor("Control `", false)).toBe("Ctrl `");
    expect(keyLabelFor("Alt Y", false)).toBe("Alt Y");
  });

  it("writes a Mac's symbols in the order its menus use, Ctrl being ⌘", () => {
    expect(keyLabelFor("Ctrl Shift G", true)).toBe("⇧⌘G");
    expect(keyLabelFor("Ctrl ,", true)).toBe("⌘,");
    expect(keyLabelFor("Control `", true)).toBe("⌃`");
    expect(keyLabelFor("Control Shift Tab", true)).toBe("⌃⇧ Tab");
    expect(keyLabelFor("Alt Y", true)).toBe("⌥Y");
    expect(keyLabelFor("Ctrl Enter", true)).toBe("⌘↩");
    expect(keyLabelFor("Ctrl Click", true)).toBe("⌘ Click");
    expect(keyLabelFor("Esc", true)).toBe("⎋");
  });
});

describe("primaryHeldFor", () => {
  it("takes Ctrl off a Mac and ⌘ on one, never both", () => {
    expect(primaryHeldFor({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(primaryHeldFor({ ctrlKey: false, metaKey: true }, false)).toBe(false);
    expect(primaryHeldFor({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(primaryHeldFor({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(primaryHeldFor({ ctrlKey: true, metaKey: true }, true)).toBe(false);
  });
});
