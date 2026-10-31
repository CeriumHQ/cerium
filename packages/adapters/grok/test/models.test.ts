import { refinedManifest, type InitializeResponse } from "@cerium/adapter-acp";
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { grokSignIn } from "../src/harness.ts";
import { grokManifest } from "../src/manifest.ts";
import { grokModels } from "../src/models.ts";

// `initialize-signed-out-1.0.70.json` is the real answer of Grok Build 1.0.70's `grok agent --no-leader
// stdio` to Cerium's `initialize`, captured in a container with no Grok login (its folder, host and
// agent ids replaced).

const initialized = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "initialize-signed-out-1.0.70.json"), "utf8"),
) as InitializeResponse;

describe("Grok Build 1.0.70's initialize", () => {
  it("lists its models with each one's efforts and default, before any session", () => {
    expect(grokModels(initialized)).toEqual([
      {
        provider: "grok",
        id: "grok-4.6",
        label: "Grok 4.6",
        description: "SpaceXAI's latest frontier model",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
        isDefault: true,
      },
      {
        provider: "grok",
        id: "grok-4.5",
        label: "Grok 4.5",
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
      },
    ]);
  });

  it("reads as signed out: only the browser login is offered", () => {
    expect(grokSignIn(initialized)).toEqual({ _tag: "SignedOut" });
  });

  it("backs every capability the manifest claims that ACP's handshake shows", () => {
    expect(refinedManifest(grokManifest, initialized.agentCapabilities!)).toEqual(grokManifest);
    expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);
  });
});
