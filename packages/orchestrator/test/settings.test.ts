import { defaultSettings } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { join } from "node:path";

import { UserSettings } from "../src/index.ts";

const readSettings = Effect.gen(function* () {
  const settings = yield* UserSettings;
  return yield* settings.get;
}).pipe(Effect.provide(UserSettings.layer));

describe("UserSettings", () => {
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
      yield* store.writeSettings({ advisor });
      assert.deepStrictEqual(yield* readSettings, { ...defaultSettings, advisor });

      yield* store.writeSettings({ advisor: { enabled: "yes" } });
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
