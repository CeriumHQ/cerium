import { describe, expect, it } from "@effect/vitest";

import { cacheSafeFromCatalog, toModelInfo } from "../src/models.ts";
import type { Model } from "../src/protocol/v2/Model.ts";

const model = (slug: string) =>
  ({
    model: slug,
    displayName: slug,
    description: "",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "low",
    isDefault: false,
  }) as unknown as Model;

describe("toModelInfo", () => {
  it("marks only models measured keeping the prompt cache across an effort switch", () => {
    expect(toModelInfo(model("gpt-6-luna")).cacheSafeEffort).toBe(true);
    expect(toModelInfo(model("gpt-5.6-terra")).cacheSafeEffort).toBeUndefined();
  });

  it("follows Codex's catalog where it names the model", () => {
    const catalog = new Map([
      ["gpt-6-astra", true],
      ["gpt-6-luna", false],
    ]);
    expect(toModelInfo(model("gpt-6-astra"), catalog).cacheSafeEffort).toBe(true);
    expect(toModelInfo(model("gpt-6-luna"), catalog).cacheSafeEffort).toBeUndefined();
    // A model the catalog leaves out falls back to the measured ones.
    expect(toModelInfo(model("gpt-6-luna"), new Map()).cacheSafeEffort).toBe(true);
  });
});

describe("cacheSafeFromCatalog", () => {
  it("reads which models take an effort change without restarting the cache", () => {
    const text = JSON.stringify({
      fetched_at: "2026-10-24T03:50:24Z",
      etag: 'W/"d78c"',
      models: [
        { slug: "gpt-6-luna", supports_reasoning_effort_updates: true, visibility: "list" },
        { slug: "gpt-5.6-terra", supports_reasoning_effort_updates: false },
        { slug: "codex-auto-review" },
      ],
    });
    expect(cacheSafeFromCatalog(text)).toEqual(
      new Map([
        ["gpt-6-luna", true],
        ["gpt-5.6-terra", false],
        ["codex-auto-review", false],
      ]),
    );
  });

  it("reads a catalog it doesn't recognise as none", () => {
    expect(cacheSafeFromCatalog("not json")).toBeUndefined();
    expect(cacheSafeFromCatalog(JSON.stringify({ data: [] }))).toBeUndefined();
    expect(
      cacheSafeFromCatalog(
        JSON.stringify({ models: [{ slug: "a", supports_reasoning_effort_updates: "yes" }] }),
      ),
    ).toBeUndefined();
  });
});
