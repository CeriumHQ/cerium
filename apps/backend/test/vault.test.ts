import { Vault } from "@cerium/account";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import { EffortRouterKey, fileEffortRouterKey, fileVault } from "../src/vault.ts";

it.effect("stores both secrets privately and repairs files from older releases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const dir = join(root, "data");
    const account = join(dir, "account.json");
    const key = join(dir, "effort-router.json");
    yield* Effect.gen(function* () {
      const signIn = yield* Vault;
      const effort = yield* EffortRouterKey;
      assert.isUndefined(yield* signIn.read);
      yield* signIn.write("first");
      yield* effort.write("key");
      if (process.platform !== "win32") {
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.equal(statSync(account).mode & 0o777, 0o600);
        assert.equal(statSync(key).mode & 0o777, 0o600);
        chmodSync(dir, 0o755);
        chmodSync(account, 0o644);
        chmodSync(key, 0o644);
      }
      assert.equal(yield* signIn.read, "first");
      yield* effort.write("new key");
      if (process.platform !== "win32") {
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.equal(statSync(account).mode & 0o777, 0o600);
        assert.equal(statSync(key).mode & 0o777, 0o600);
      }
      assert.equal(yield* effort.read, "new key");
      yield* signIn.write(undefined);
      assert.isUndefined(yield* signIn.read);
    }).pipe(Effect.provide(Layer.merge(fileVault(account), fileEffortRouterKey(key))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
