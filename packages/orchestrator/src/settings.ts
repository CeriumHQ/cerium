import { defaultSettings, Settings, type SettingsPatch } from "@cerium/protocol";
import { Store, type StoreError } from "@cerium/store";
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream, SubscriptionRef } from "effect";

import { OrchestratorError } from "./errors.ts";

const unavailable = (error: StoreError) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

/**
 * Each stored value that still decodes, over the defaults: a value an older version wrote in another
 * shape falls back to its default without resetting the rest.
 */
const decodeSettings = (stored: Readonly<Record<string, unknown>>): Settings => ({
  ...defaultSettings,
  ...Object.fromEntries(
    Object.entries(Settings.fields).flatMap(([key, field]) =>
      Option.toArray(Schema.decodeUnknownOption(field)(stored[key])).map((value) => [key, value]),
    ),
  ),
});

/** The user's settings, kept in the store. Read when they matter, so a change applies from then on. */
export class UserSettings extends Context.Service<
  UserSettings,
  {
    readonly get: Effect.Effect<Settings>;
    /** Saves the given settings and returns them all. */
    update(patch: SettingsPatch): Effect.Effect<Settings, OrchestratorError>;
    /** The settings now and each time they're saved, for what applies a change at once. */
    readonly changes: Stream.Stream<Settings>;
  }
>()("cerium/orchestrator/UserSettings") {
  static readonly layer = Layer.effect(
    UserSettings,
    Effect.gen(function* () {
      const store = yield* Store;
      const current = yield* SubscriptionRef.make(
        decodeSettings(yield* store.readSettings.pipe(Effect.mapError(unavailable))),
      );
      // Saving and remembering happen together, so concurrent updates can't land out of order.
      const lock = yield* Semaphore.make(1);

      const update = Effect.fn("UserSettings.update")(function* (patch: SettingsPatch) {
        yield* store.writeSettings(patch).pipe(Effect.mapError(unavailable));
        return yield* SubscriptionRef.updateAndGet(current, (settings) => ({ ...settings, ...patch }));
      }, lock.withPermits(1));

      return UserSettings.of({
        get: SubscriptionRef.get(current),
        update,
        changes: SubscriptionRef.changes(current),
      });
    }),
  );
}
