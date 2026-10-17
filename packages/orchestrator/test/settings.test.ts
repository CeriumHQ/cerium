import { makeFakeAdapter } from "@cerium/harness/testing";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
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

      yield* startWorkThread;
      assert.isTrue(fake.sessions[0]?.options.includeUserMcpServers);

      assert.deepStrictEqual(yield* settings.update({ includeUserMcpServers: false }), {
        includeUserMcpServers: false,
      });
      yield* startWorkThread;
      assert.isFalse(fake.sessions[1]?.options.includeUserMcpServers);
      assert.deepStrictEqual(yield* store.readSettings, { includeUserMcpServers: false });
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.effect("reads saved settings back, and defaults any it can't decode", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      assert.deepStrictEqual(yield* readSettings, { includeUserMcpServers: true });

      yield* store.writeSettings({ includeUserMcpServers: false });
      assert.deepStrictEqual(yield* readSettings, { includeUserMcpServers: false });

      yield* store.writeSettings({ includeUserMcpServers: "no" });
      assert.deepStrictEqual(yield* readSettings, { includeUserMcpServers: true });
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
