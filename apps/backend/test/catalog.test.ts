import { makeFakeAdapter } from "@cerium/harness/testing";
import { Adapters, Catalog, UserSettings } from "@cerium/orchestrator";
import {
  defaultSettings,
  withHarnessRoster,
  type ModelInfo,
  type ProviderId,
  type RosterMember,
  type Settings,
} from "@cerium/protocol";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { CatalogLive, catalogEntries, OfferedModels } from "../src/catalog.ts";

const model = (provider: ProviderId, id: string): ModelInfo => ({
  provider,
  id,
  label: id.toUpperCase(),
  efforts: [],
});
const member = (provider: ProviderId, id: string): RosterMember => ({ model: model(provider, id), use: id });

describe("catalogEntries", () => {
  it("names each model by its id, prefixed by its harness where two harnesses share the id", () => {
    expect(
      catalogEntries([member("claude", "opus"), member("muse", "spark"), member("cursor", "spark")]),
    ).toEqual([
      { alias: "opus", provider: "claude", model: "opus", description: "opus" },
      { alias: "muse/spark", provider: "muse", model: "spark", description: "spark" },
      { alias: "cursor/spark", provider: "cursor", model: "spark", description: "spark" },
    ]);
  });
});

/** Claude offers its models; Codex offers none until `signIn`, as a logged-out harness. */
const harnesses = () => {
  const state = { codexSignedIn: false, codexListings: 0 };
  const claude = {
    ...makeFakeAdapter("claude").adapter,
    listModels: Effect.succeed([model("claude", "opus"), model("claude", "haiku"), model("claude", "fable")]),
  };
  const codex = {
    ...makeFakeAdapter("codex").adapter,
    listModels: Effect.suspend(() => {
      state.codexListings++;
      return state.codexSignedIn ? Effect.succeed([model("codex", "gpt-6-luna")]) : Effect.die("logged out");
    }),
  };
  const settings = { current: defaultSettings as Settings };
  const layer = CatalogLive.pipe(
    Layer.provideMerge(OfferedModels.layer),
    Layer.provideMerge(Adapters.fromList([claude, codex])),
    Layer.provideMerge(
      Layer.succeed(
        UserSettings,
        UserSettings.of({
          get: Effect.sync(() => settings.current),
          update: () => Effect.die("unused"),
          changes: Stream.empty,
        }),
      ),
    ),
  );
  return { state, settings, layer };
};

const aliases = Effect.gen(function* () {
  const entries = yield* (yield* Catalog).entries;
  return entries.map((entry) => entry.alias);
});

/** Waits for the background listing to land. */
const eventually = <A, R>(read: Effect.Effect<A, never, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* read;
  });

describe("CatalogLive", () => {
  it.live("offers each signed-in harness's starting picks, and a harness once it signs in", () => {
    const { state, layer } = harnesses();
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku"]);
      state.codexSignedIn = true;
      yield* (yield* OfferedModels).relistEmpty(["codex"]);
      assert.deepStrictEqual(yield* eventually(aliases, (each) => each.length === 3), [
        "opus",
        "haiku",
        "gpt-6-luna",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("doesn't ask a harness that offered nothing again on every read", () => {
    const { state, layer } = harnesses();
    return Effect.gen(function* () {
      yield* aliases;
      yield* aliases;
      yield* Effect.sleep("20 millis");
      assert.strictEqual(state.codexListings, 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("follows the roster as it's changed, and takes the UI's fresh listing", () => {
    const { settings, layer } = harnesses();
    return Effect.gen(function* () {
      settings.current = {
        ...defaultSettings,
        roster: withHarnessRoster(defaultSettings.roster, "claude", [
          { provider: "claude", model: "fable", use: "Architecture" },
        ]),
      };
      const catalog = yield* Catalog;
      assert.deepStrictEqual(yield* catalog.entries, [
        { alias: "fable", provider: "claude", model: "fable", description: "Architecture" },
      ]);
      yield* (yield* OfferedModels).offer("codex", [model("codex", "gpt-6-sol")]);
      assert.deepStrictEqual(yield* aliases, ["fable", "gpt-6-sol"]);
      // Every model offered stays known to the quick models, on the roster or not.
      assert.deepStrictEqual(
        (yield* catalog.models!).map((each) => each.id),
        ["opus", "haiku", "fable", "gpt-6-sol"],
      );
    }).pipe(Effect.provide(layer));
  });
});
