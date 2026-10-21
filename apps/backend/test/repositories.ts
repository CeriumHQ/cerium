import { afterAll } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { rmSync, statSync } from "node:fs";

// The repositories git tests start from. Git takes a tenth of a second or more to start on Windows,
// and a repository made with `init`, its settings and a first commit cost every test half a dozen
// of those starts before it checked anything. `madeOnce` makes it once per test file and copies the
// folder for each test instead.

/**
 * Copies to `to` a folder `make` fills the first time a test asks for one. The original lasts until
 * the file's tests finish. Call it at the top of a test file, so each file makes its own.
 */
export const madeOnce = <E, R>(make: (folder: string) => Effect.Effect<void, E, R>) => {
  let made: string | undefined;
  afterAll(() => {
    if (made !== undefined) rmSync(made, { recursive: true, force: true, maxRetries: 5 });
  });
  return Effect.fn("madeOnce")(function* (to: string) {
    const fs = yield* FileSystem.FileSystem;
    if (made === undefined) {
      const folder = yield* fs.makeTempDirectory();
      yield* make(folder).pipe(
        Effect.onError(() => fs.remove(folder, { recursive: true }).pipe(Effect.ignore)),
      );
      made = folder;
    }
    yield* fs.copy(made, to);
  });
};

/**
 * Whether two paths name the same folder. Compares the file system's identity for each rather than
 * the text, which on Windows can name one folder by its short (`RUNNER~1`) or long name.
 */
export const sameFolder = (one: string, other: string) => {
  const a = statSync(one, { bigint: true });
  const b = statSync(other, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
};
