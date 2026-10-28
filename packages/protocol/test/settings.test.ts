import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { defaultSettings, Settings, SettingsPatch } from "../src/settings.ts";

describe("SettingsPatch", () => {
  it("decodes only the settings it names, so saving one leaves the rest alone", () => {
    const effortRouter = { enabled: true, children: "router", fallback: "medium" } as const;
    expect(Schema.decodeSync(SettingsPatch)({ effortRouter })).toStrictEqual({ effortRouter });
    expect(Schema.decodeSync(SettingsPatch)({})).toStrictEqual({});
  });

  it("reads the router's fallback as high from settings saved before it", () => {
    expect(
      Schema.decodeSync(Settings)({ ...defaultSettings, effortRouter: { enabled: true, children: "lead" } })
        .effortRouter,
    ).toStrictEqual({ enabled: true, children: "lead", fallback: "high" });
  });

  it("still reads a setting missing from the full settings as its default", () => {
    const { advisor: _, ...rest } = defaultSettings;
    expect(Schema.decodeSync(Settings)(rest)).toStrictEqual(defaultSettings);
  });
});
