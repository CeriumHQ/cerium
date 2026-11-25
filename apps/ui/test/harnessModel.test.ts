import type { HarnessStatus, ProviderId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { partitionHarnesses } from "../src/features/settings/harnessModel.ts";

const installed = (provider: ProviderId, loggedIn = true): HarnessStatus => ({
  _tag: "HarnessInstalled",
  provider,
  executablePath: `/usr/local/bin/${provider}`,
  version: "1.0.0",
  auth: loggedIn ? { _tag: "LoggedIn" } : { _tag: "LoggedOut" },
});

const missing = (provider: ProviderId): HarnessStatus => ({
  _tag: "HarnessMissing",
  provider,
  installHint: `Install ${provider}`,
});

describe("partitionHarnesses", () => {
  it("separates enabled harnesses from disabled ones and orders disabled ones by readiness", () => {
    const providers: ReadonlyArray<ProviderId> = [
      "claude",
      "codex",
      "muse",
      "cursor",
      "opencode",
      "copilot",
      "devin",
    ];
    const statuses: ReadonlyArray<HarnessStatus> = [
      installed("claude", true),
      installed("codex", true),
      missing("muse"),
      installed("cursor", false),
      installed("opencode", true),
      installed("copilot", true),
    ];
    const { enabled, disabled } = partitionHarnesses(providers, statuses, ["copilot", "codex"]);

    expect(enabled).toEqual(["claude", "opencode"]);
    expect(disabled).toEqual(["codex", "copilot", "cursor", "muse", "devin"]);
  });

  it("handles all enabled or all disabled cleanly", () => {
    const providers: ReadonlyArray<ProviderId> = ["claude", "codex"];
    const statuses = [installed("claude", true), installed("codex", true)];

    expect(partitionHarnesses(providers, statuses, [])).toEqual({
      enabled: ["claude", "codex"],
      disabled: [],
    });
    expect(partitionHarnesses(providers, statuses, ["claude", "codex"])).toEqual({
      enabled: [],
      disabled: ["claude", "codex"],
    });
  });
});
