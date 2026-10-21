import { describe, expect, it } from "@effect/vitest";

import { desktopEntry, quoteExecArg } from "../src/autostart.ts";

describe("quoteExecArg", () => {
  it("leaves plain paths and flags as they are", () => {
    expect(quoteExecArg("/home/me/Apps/Cerium-1.0.0-x86_64.AppImage")).toBe(
      "/home/me/Apps/Cerium-1.0.0-x86_64.AppImage",
    );
    expect(quoteExecArg("--hidden")).toBe("--hidden");
  });

  it("quotes spaces and escapes what the Exec key reserves", () => {
    expect(quoteExecArg("/home/me/My Apps/Cerium.AppImage")).toBe('"/home/me/My Apps/Cerium.AppImage"');
    expect(quoteExecArg('/home/me/a"b$c`d\\e')).toBe('"/home/me/a\\"b\\$c\\`d\\\\e"');
  });
});

describe("desktopEntry", () => {
  it("starts the AppImage with the given flags", () => {
    expect(desktopEntry("/opt/Cerium.AppImage", ["--hidden"])).toContain(
      "\nExec=/opt/Cerium.AppImage --hidden\n",
    );
  });
});
