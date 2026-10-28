import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Each executable file named `program` in the folders of `pathList` (a POSIX PATH), in their order,
 * as `which -a` lists them.
 */
export const executablesOnPath = Effect.fn("executablesOnPath")(function* (
  program: string,
  pathList: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  for (const folder of pathList.split(":")) {
    // An empty entry means the current folder, which `which` skips too.
    if (folder === "") continue;
    const candidate = path.join(folder, program);
    if (found.includes(candidate)) continue;
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
      found.push(candidate);
    }
  }
  return found as ReadonlyArray<string>;
});

/**
 * Every `program` on PATH, in PATH's order: what Windows' `where` lists (shims and all), or on macOS
 * and Linux each executable file of that name. Not `which` itself, which Arch's base system, minimal
 * Fedora and many containers don't install, and whose absence read as every harness missing. None
 * when nothing can be found.
 */
export const findOnPath = Effect.fn("findOnPath")(function* (program: string) {
  if (process.platform !== "win32") return yield* executablesOnPath(program, process.env["PATH"] ?? "");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.lines(ChildProcess.make("where", [program])).pipe(
    Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
});
