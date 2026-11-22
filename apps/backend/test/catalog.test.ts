import { HarnessUnavailable, type HarnessAdapter } from "@cerium/harness";
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
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { CatalogLive, catalogEntries, OfferedModels } from "../src/catalog.ts";

const model = (provider: ProviderId, id: string): ModelInfo => ({
  provider,
  id,
  label: id.toUpperCase(),
  efforts: [],
});
const member = (provider: ProviderId, id: string, extra: Partial<RosterMember> = {}): RosterMember => ({
  model: model(provider, id),
  use: id,
  priority: 1,
  ...extra,
});

describe("catalogEntries", () => {
  it("names each model by its id, prefixed by its harness where two harnesses share the id", () => {
    expect(
      catalogEntries([
        member("claude", "opus", { speed: "fast" }),
        member("claude", "haiku", { priority: 2 }),
        member("muse", "spark"),
        member("cursor", "spark"),
      ]),
    ).toEqual([
      { alias: "opus", provider: "claude", model: "opus", speed: "fast", description: "opus", priority: 1 },
      { alias: "haiku", provider: "claude", model: "haiku", description: "haiku", priority: 2 },
      { alias: "muse/spark", provider: "muse", model: "spark", description: "spark", priority: 1 },
      { alias: "cursor/spark", provider: "cursor", model: "spark", description: "spark", priority: 1 },
    ]);
  });
});

const codexUnavailable = new HarnessUnavailable({
  provider: "codex",
  reason: "loggedOut",
  message: "Sign in to Codex.",
});

const codexStatus = {
  _tag: "HarnessInstalled",
  provider: "codex",
  executablePath: "/codex",
  version: "1",
} as const;

/** Claude offers its models. The test controls when Codex answers and what it offers. */
const harnesses = (listModels: HarnessAdapter["listModels"]) => {
  const claude = {
    ...makeFakeAdapter("claude").adapter,
    listModels: Effect.succeed([model("claude", "opus"), model("claude", "haiku"), model("claude", "fable")]),
  };
  const codex = { ...makeFakeAdapter("codex").adapter, listModels };
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
  return { settings, layer };
};

const aliases = Effect.gen(function* () {
  const entries = yield* (yield* Catalog).entries;
  return entries.map((entry) => entry.alias);
});

describe("CatalogLive", () => {
  it.effect("shares startup discovery with concurrent model requests and survives a canceled viewer", () => {
    const started = Deferred.makeUnsafe<void>();
    const answer = Deferred.makeUnsafe<ReadonlyArray<ModelInfo>>();
    let calls = 0;
    const { layer } = harnesses(
      Effect.sync(() => calls++).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(answer)),
      ),
    );
    return Effect.gen(function* () {
      const offered = yield* OfferedModels;
      yield* Effect.forkChild(offered.all);
      yield* Deferred.await(started);
      const [first, second] = yield* Effect.all([
        Effect.forkChild(offered.list("codex"), { startImmediately: true }),
        Effect.forkChild(offered.list("codex"), { startImmediately: true }),
      ]);
      yield* Fiber.interrupt(first);
      const models = [model("codex", "gpt-6-luna")];
      yield* Deferred.succeed(answer, models);
      assert.deepStrictEqual(yield* Fiber.join(second), models);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      assert.deepStrictEqual(yield* offered.list("codex"), models);
      assert.strictEqual(calls, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reuses unavailable results and invalidates them when a probe finds a sign-in", () => {
    let calls = 0;
    let signedIn = false;
    const models = [model("codex", "gpt-6-luna")];
    const { layer } = harnesses(
      Effect.suspend(() => {
        calls++;
        return signedIn ? Effect.succeed(models) : Effect.fail(codexUnavailable);
      }),
    );
    return Effect.gen(function* () {
      const offered = yield* OfferedModels;
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku"]);
      assert.strictEqual(yield* Effect.flip(offered.list("codex")), codexUnavailable);
      assert.strictEqual(calls, 1);
      signedIn = true;
      yield* offered.observe({ ...codexStatus, auth: { _tag: "LoggedIn" } });
      assert.deepStrictEqual(yield* offered.list("codex"), models);
      yield* offered.observe({ ...codexStatus, auth: { _tag: "LoggedIn" } });
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reloads expired lists in the background and shares the refreshed result with the UI", () => {
    let calls = 0;
    const updated = Deferred.makeUnsafe<ReadonlyArray<ModelInfo>>();
    const original = [model("codex", "gpt-6-luna")];
    const { layer } = harnesses(
      Effect.suspend(() => (++calls === 1 ? Effect.succeed(original) : Deferred.await(updated))),
    );
    return Effect.gen(function* () {
      const offered = yield* OfferedModels;
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      yield* TestClock.adjust("59 seconds");
      assert.deepStrictEqual(yield* offered.list("codex"), original);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      const fresh = yield* Effect.forkChild(offered.list("codex"), { startImmediately: true });
      const models = [model("codex", "gpt-6-sol")];
      yield* Deferred.succeed(updated, models);
      assert.deepStrictEqual(yield* Fiber.join(fresh), models);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-sol"]);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("bounds a stalled startup listing and tries it again after expiry", () => {
    let calls = 0;
    const models = [model("codex", "gpt-6-luna")];
    const { layer } = harnesses(
      Effect.suspend(() => (++calls === 1 ? Effect.never : Effect.succeed(models))),
    );
    return Effect.gen(function* () {
      const offered = yield* OfferedModels;
      const viewer = yield* Effect.forkChild(Effect.flip(offered.list("codex")), { startImmediately: true });
      yield* TestClock.adjust("20 seconds");
      assert.match((yield* Fiber.join(viewer)).message, /timed out/i);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku"]);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* offered.list("codex"), models);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("moves pending startup and UI reads to the new listing after sign-in", () => {
    const beforeSignIn = Deferred.makeUnsafe<ReadonlyArray<ModelInfo>>();
    const started = Deferred.makeUnsafe<void>();
    const models = [model("codex", "gpt-6-luna")];
    let calls = 0;
    const { layer } = harnesses(
      Effect.suspend(() => {
        if (++calls !== 1) return Effect.succeed(models);
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(beforeSignIn)));
      }),
    );
    return Effect.gen(function* () {
      const offered = yield* OfferedModels;
      yield* Effect.forkChild(offered.all);
      yield* Deferred.await(started);
      const viewer = yield* Effect.forkChild(offered.list("codex"), { startImmediately: true });
      yield* offered.invalidate("codex");
      assert.deepStrictEqual(yield* Fiber.join(viewer), models);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      yield* Deferred.succeed(beforeSignIn, [model("codex", "old-account")]);
      yield* TestClock.adjust(0);
      assert.deepStrictEqual(yield* offered.list("codex"), models);
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-luna"]);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows the roster as it's changed and keeps the full offered model list", () => {
    const { settings, layer } = harnesses(Effect.succeed([model("codex", "gpt-6-sol")]));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-sol"]);
      settings.current = {
        ...defaultSettings,
        roster: withHarnessRoster(defaultSettings.roster, "claude", [
          { provider: "claude", model: "fable", use: "Architecture" },
        ]),
      };
      const catalog = yield* Catalog;
      assert.deepStrictEqual(yield* catalog.entries, [
        { alias: "fable", provider: "claude", model: "fable", description: "Architecture", priority: 1 },
        { alias: "gpt-6-sol", provider: "codex", model: "gpt-6-sol", description: "GPT-6-SOL", priority: 1 },
      ]);
      // Every model offered stays known to the quick models, on the roster or not.
      assert.deepStrictEqual(
        (yield* catalog.models!).map((each) => each.id),
        ["opus", "haiku", "fable", "gpt-6-sol"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves out the harnesses the user turned off, and brings them back when turned on", () => {
    const { settings, layer } = harnesses(Effect.succeed([model("codex", "gpt-6-sol")]));
    return Effect.gen(function* () {
      const catalog = yield* Catalog;
      settings.current = { ...defaultSettings, disabledProviders: ["claude"] };
      assert.deepStrictEqual(yield* aliases, ["gpt-6-sol"]);
      assert.deepStrictEqual(
        (yield* catalog.models!).map((each) => each.id),
        ["gpt-6-sol"],
      );
      settings.current = defaultSettings;
      assert.deepStrictEqual(yield* aliases, ["opus", "haiku", "gpt-6-sol"]);
    }).pipe(Effect.provide(layer));
  });
});
