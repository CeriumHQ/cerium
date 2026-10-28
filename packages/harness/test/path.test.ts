import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { executablesOnPath, scratchFolder } from "../src/index.ts";

/** A file system holding only `files`, each a file or folder with its permission bits. */
const holding = (files: Record<string, { type: FileSystem.File.Type; mode: number }>) => {
  const none = FileSystem.makeNoop({});
  return Layer.mergeAll(
    FileSystem.layerNoop({
      stat: (path) => {
        const file = files[path];
        return file === undefined ? none.stat(path) : Effect.succeed(file as unknown as FileSystem.File.Info);
      },
    }),
    Path.layer,
  );
};

describe("scratchFolder", () => {
  it.effect("makes the named folder for this user alone, outside Linux's shared /tmp", () => {
    const made: Array<{ path: string; mode: number | undefined }> = [];
    return Effect.gen(function* () {
      const folder = yield* scratchFolder("cursor", "cerium-cursor-usage");
      assert.isTrue(folder.endsWith("cerium-cursor-usage"));
      assert.deepStrictEqual(made, [{ path: folder, mode: 0o700 }]);
      if (process.platform === "linux") assert.isFalse(folder.startsWith("/tmp/"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            makeDirectory: (path, options) =>
              Effect.sync(() => void made.push({ path, mode: options?.mode })),
          }),
          Path.layer,
        ),
      ),
    );
  });
});

describe("executablesOnPath", () => {
  it.effect("lists each executable of that name in PATH's order, as `which -a` does", () =>
    Effect.gen(function* () {
      const found = yield* executablesOnPath(
        "claude",
        "/home/ada/.local/bin::/usr/local/bin:/opt/tools:/usr/bin:/home/ada/.local/bin",
      );
      assert.deepStrictEqual(found, ["/home/ada/.local/bin/claude", "/usr/bin/claude"]);
    }).pipe(
      Effect.provide(
        holding({
          "/home/ada/.local/bin/claude": { type: "File", mode: 0o755 },
          // Not executable, and a folder of that name: `which` passes both over.
          "/usr/local/bin/claude": { type: "File", mode: 0o644 },
          "/opt/tools/claude": { type: "Directory", mode: 0o755 },
          "/usr/bin/claude": { type: "File", mode: 0o700 },
        }),
      ),
    ),
  );

  it.effect("finds none on an empty PATH or where nothing matches", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* executablesOnPath("gh", ""), []);
      assert.deepStrictEqual(yield* executablesOnPath("gh", "/usr/bin:/bin"), []);
    }).pipe(Effect.provide(holding({}))),
  );
});
