import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git } from "../src/git.ts";
import { GitBranches } from "../src/gitBranches.ts";
import { madeOnce } from "./repositories.ts";

// Real repositories, as the service sees them.
const TestLayer = GitBranches.layer.pipe(Layer.provide(Git.layer), Layer.provideMerge(NodeServices.layer));

/** Runs git in `cwd` as the test's own user, away from the machine's git configuration. */
const git = Effect.fn("git")(function* (cwd: string, ...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args],
      { cwd },
    ),
  );
});

/** Gives the repository at `root` its own identity, and keeps the machine's line endings and signing out. */
const configure = Effect.fn("configure")(function* (root: string, name: string) {
  for (const [key, value] of [
    ["user.name", name],
    ["user.email", `${name.toLowerCase()}@example.com`],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
  ] as const) {
    yield* git(root, "config", key, value);
  }
});

/** Gives each file a base repository to copy and each test a scoped folder to work in. */
export const makeGitBranchesFixture = () => {
  /** A repository on `main` with one commit that holds `a.txt`, as Test. */
  const based = madeOnce(
    Effect.fn("based")(function* (root: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* git(root, "init", "-q", "-b", "main");
      yield* configure(root, "Test");
      yield* fs.writeFileString(path.join(root, "a.txt"), "base\n");
      yield* git(root, "add", "-A");
      yield* git(root, "commit", "-q", "-m", "base");
    }),
  );

  /** A folder of temporary repositories: `init` makes one with its own identity, `remote` a bare one. */
  const sandbox = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const write = (root: string, name: string, text: string) =>
      fs
        .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
    const read = (root: string, name: string) => fs.readFileString(path.join(root, name));
    const exists = (root: string, name: string) => fs.exists(path.join(root, name));
    /** Makes a repository with one commit that holds `a.txt`. */
    const init = Effect.fn("init")(function* (name: string) {
      const root = path.join(base, name);
      yield* based(root);
      return root;
    });
    /** Commits `text` to `file` on whatever is checked out in `root`. */
    const commit = Effect.fn("commit")(function* (
      root: string,
      file: string,
      text: string,
      message = "change",
    ) {
      yield* write(root, file, text);
      yield* git(root, "add", "-A");
      yield* git(root, "commit", "-q", "-m", message);
    });
    /** A bare repository for `root` to push to, as its `origin`. */
    const remote = Effect.fn("remote")(function* (root: string, name = "origin.git") {
      const bare = path.join(base, name);
      yield* git(base, "init", "-q", "--bare", "-b", "main", bare);
      yield* git(root, "remote", "add", "origin", bare);
      return bare;
    });
    /** Another clone of `bare`, as a second person's. */
    const clone = Effect.fn("clone")(function* (bare: string, name: string) {
      const root = path.join(base, name);
      yield* git(base, "clone", "-q", bare, root);
      yield* configure(root, "Other");
      return root;
    });
    return { base, path, fs, write, read, exists, init, commit, remote, clone };
  });

  return { git, sandbox, TestLayer };
};
