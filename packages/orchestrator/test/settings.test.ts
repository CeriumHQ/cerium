import { makeFakeAdapter } from "@cerium/harness/testing";
import { defaultSettings } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";
import { join } from "node:path";

import { Orchestrator, UserSettings } from "../src/index.ts";
import { testLayer } from "./fakes.ts";

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

/** The adapter's `index`th session, once the thread has started it behind its creation. */
const started = (fake: ReturnType<typeof makeFakeAdapter>, index: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const session = fake.sessions[index];
      if (session !== undefined) return session;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error(`Session ${index} never started`));
  });

const readSettings = Effect.gen(function* () {
  const settings = yield* UserSettings;
  return yield* settings.get;
}).pipe(Effect.provide(UserSettings.layer));

describe("UserSettings", () => {
  it.live("loads the user's own MCP servers into sessions until they turn it off", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const settings = yield* UserSettings;
      const store = yield* Store;

      // Sessions start behind the thread.
      yield* startWorkThread;
      assert.isTrue((yield* started(fake, 0)).options.includeUserMcpServers);

      assert.deepStrictEqual(yield* settings.update({ includeUserMcpServers: false }), {
        ...defaultSettings,
        includeUserMcpServers: false,
      });
      yield* startWorkThread;
      assert.isFalse((yield* started(fake, 1)).options.includeUserMcpServers);
      assert.deepStrictEqual(yield* store.readSettings, { includeUserMcpServers: false });
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.effect("streams the settings now and each change saved", () =>
    Effect.gen(function* () {
      const settings = yield* UserSettings;
      const seen = yield* settings.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      const discord = { enabled: true, showProject: false };
      yield* settings.update({ discord });
      assert.deepStrictEqual(Array.from(yield* Fiber.join(seen)), [
        defaultSettings,
        { ...defaultSettings, discord },
      ]);
    }).pipe(
      Effect.provide(
        UserSettings.layer.pipe(
          Layer.provide(
            Store.layer({
              filename: ":memory:",
              migrationsFolder: join(import.meta.dirname, "../../store/migrations"),
            }),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("reads saved settings back, and defaults any it can't decode", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      assert.deepStrictEqual(yield* readSettings, defaultSettings);

      const advisor = { enabled: true, model: { provider: "claude", model: "opus", effort: "max" } } as const;
      yield* store.writeSettings({ includeUserMcpServers: false, advisor });
      assert.deepStrictEqual(yield* readSettings, {
        ...defaultSettings,
        includeUserMcpServers: false,
        advisor,
      });

      yield* store.writeSettings({ includeUserMcpServers: "no", advisor: { enabled: "yes" } });
      assert.deepStrictEqual(yield* readSettings, defaultSettings);
    }).pipe(
      Effect.provide(
        Store.layer({
          filename: ":memory:",
          migrationsFolder: join(import.meta.dirname, "../../store/migrations"),
        }),
      ),
    ),
  );
});
