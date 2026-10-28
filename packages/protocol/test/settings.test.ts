import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { defaultSettings, Settings, SettingsPatch } from "../src/settings.ts";

describe("SettingsPatch", () => {
  it("decodes only the settings it names, so saving one leaves the rest alone", () => {
    const effortRouter = { enabled: true, children: "router" } as const;
    expect(Schema.decodeSync(SettingsPatch)({ effortRouter })).toStrictEqual({ effortRouter });
    expect(Schema.decodeSync(SettingsPatch)({})).toStrictEqual({});
  });

  it("still reads a setting missing from the full settings as its default", () => {
    const { advisor: _, ...rest } = defaultSettings;
    expect(Schema.decodeSync(Settings)(rest)).toStrictEqual(defaultSettings);
  });
});
