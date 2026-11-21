import { Worktrees } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Terminals } from "../src/terminal.ts";
import { Git } from "../src/git.ts";
import { worktreesLayer } from "../src/worktree.ts";

/** Runs git in `cwd` as the test's own user, away from the machine's git configuration. */
export const git = Effect.fn("git")(function* (cwd: string, ...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args],
      { cwd },
    ),
  );
});

export const closed: Array<string> = [];
const fakeTerminals = Layer.succeed(Terminals, {
  closeThread: (threadId: ThreadId) => Effect.sync(() => void closed.push(threadId)),
} as unknown as Terminals["Service"]);

/** A repository with an app in a subfolder, environment files and a built folder, and a home for its worktrees. */
export const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fs.makeTempDirectoryScoped();
  const home = yield* fs.makeTempDirectoryScoped();
  const write = (root: string, name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  yield* git(repo, "init", "-q", "-b", "main");
  yield* write(repo, ".gitignore", ".env\n.env.*\n!.env.example\ndist/\nsecrets.json\n");
  yield* write(repo, ".env.example", "KEY=\n");
  yield* write(repo, "app/src/index.ts", "export {};\n");
  yield* git(repo, "add", "-A");
  yield* git(repo, "commit", "-q", "-m", "first");
  yield* write(repo, ".env", "KEY=root\n");
  yield* write(repo, "app/.env.local", "KEY=app\n");
  yield* write(repo, "dist/out.js", "built\n");
  yield* write(repo, "secrets.json", "{}\n");
  const service = yield* Layer.build(worktreesLayer({ directory: home }));
  const planned = Context.get(service, Worktrees);
  /** Plans a worktree and checks it out, as a new thread does behind it. */
  const create = (project: string, name: string) =>
    Effect.gen(function* () {
      const made = yield* planned.plan(project, name);
      return { ...made, copied: yield* planned.checkOut(made.worktree) };
    });
  const worktrees = { ...planned, create };
  return { fs, path, repo, home, write, worktrees };
});

export const TestLayer = Layer.mergeAll(Git.layer, fakeTerminals).pipe(
  Layer.provideMerge(NodeServices.layer),
);
