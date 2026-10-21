import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Repositories } from "../src/clone.ts";
import { Git } from "../src/git.ts";
import { History } from "../src/history.ts";

// The services against real repositories, as git makes them.

const TestLayer = Layer.mergeAll(History.layer, Repositories.layer).pipe(
  Layer.provide(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** Runs git in `cwd` as the test's own user, away from the machine's git configuration. */
const git = Effect.fn("git")(function* (cwd: string, ...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make(
      "git",
      [
        "-c",
        "user.name=Ann Lee",
        "-c",
        "user.email=ann@example.com",
        "-c",
        "core.autocrlf=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd },
    ),
  );
});

/** A repository with four commits, the last of which renames a file and adds another. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  yield* git(root, "init", "-q");
  yield* write("src/app.ts", "one\ntwo\nthree\n");
  yield* git(root, "add", "-A");
  yield* git(root, "commit", "-q", "-m", "Add the app");
  yield* write("src/app.ts", "one\nTWO\nthree\n");
  yield* git(root, "commit", "-q", "-am", "Fix login bug\n\nThe second line was wrong.");
  yield* write("README.md", "# Title\n");
  yield* git(root, "add", "-A");
  yield* git(root, "commit", "-q", "-m", "Document it", "--author=Bob Ray <bob@example.com>");
  yield* git(root, "mv", "src/app.ts", "src/main.ts");
  yield* git(root, "commit", "-q", "-m", "Rename the app");
  return { root, write, fs, path };
});

describe("History", { timeout: 30_000 }, () => {
  it.effect("pages the branch's commits newest first, and says when more follow", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root } = yield* repository;
      const first = yield* history.commits(root, { offset: 0, limit: 2 });
      assert.isTrue(first.repository);
      assert.deepStrictEqual(
        first.commits.map((commit) => commit.subject),
        ["Rename the app", "Document it"],
      );
      assert.isTrue(first.more);
      const rest = yield* history.commits(root, { offset: 2, limit: 2 });
      assert.deepStrictEqual(
        rest.commits.map((commit) => commit.subject),
        ["Fix login bug", "Add the app"],
      );
      assert.isFalse(rest.more);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("filters by message or by author, and keeps the paging", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root } = yield* repository;
      const byMessage = yield* history.commits(root, { query: "LOGIN", offset: 0, limit: 10 });
      assert.deepStrictEqual(
        byMessage.commits.map((commit) => commit.subject),
        ["Fix login bug"],
      );
      const byAuthor = yield* history.commits(root, { query: "bob ray", offset: 0, limit: 10 });
      assert.deepStrictEqual(
        byAuthor.commits.map((commit) => commit.subject),
        ["Document it"],
      );
      const everyone = yield* history.commits(root, { query: "ann lee", offset: 0, limit: 2 });
      assert.deepStrictEqual(
        everyone.commits.map((commit) => commit.subject),
        ["Rename the app", "Fix login bug"],
      );
      assert.isTrue(everyone.more);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("marks what no remote branch holds, once there is a remote", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root, write, fs } = yield* repository;
      const remote = yield* fs.makeTempDirectoryScoped();
      yield* git(remote, "init", "-q", "--bare");
      yield* git(root, "remote", "add", "origin", remote);
      yield* git(root, "push", "-q", "origin", "main");
      yield* write("local.txt", "not pushed\n");
      yield* git(root, "add", "-A");
      yield* git(root, "commit", "-q", "-m", "Local only");
      const page = yield* history.commits(root, { offset: 0, limit: 10 });
      assert.deepStrictEqual(
        page.commits.map((commit) => [commit.subject, commit.unpushed === true]),
        [
          ["Local only", true],
          ["Rename the app", false],
          ["Document it", false],
          ["Fix login bug", false],
          ["Add the app", false],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("shows the branch, tags and upstreams a commit carries as refs", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root } = yield* repository;
      yield* git(root, "tag", "v1.0.0", "HEAD~1");
      const page = yield* history.commits(root, { offset: 0, limit: 10 });
      assert.deepStrictEqual(page.commits[0]!.refs, [{ kind: "branch", name: "main", current: true }]);
      assert.deepStrictEqual(page.commits[1]!.refs, [{ kind: "tag", name: "v1.0.0" }]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says a folder outside git has no history", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      assert.deepStrictEqual(yield* history.commits(root, { offset: 0, limit: 10 }), {
        repository: false,
        commits: [],
        more: false,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says a repository with no commit has an empty history", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* git(root, "init", "-q");
      assert.deepStrictEqual(yield* history.commits(root, { offset: 0, limit: 10 }), {
        repository: true,
        commits: [],
        more: false,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reads a commit's message and the files it changed, a rename included", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root } = yield* repository;
      const page = yield* history.commits(root, { offset: 0, limit: 10 });
      const fix = page.commits.find((commit) => commit.subject === "Fix login bug")!;
      const detail = yield* history.detail(root, fix.sha);
      assert.strictEqual(detail.message, "Fix login bug\n\nThe second line was wrong.");
      assert.deepStrictEqual(detail.files, [{ path: "src/app.ts", state: "modified" }]);

      const rename = page.commits[0]!;
      const renamed = yield* history.detail(root, rename.sha);
      assert.deepStrictEqual(renamed.files, [{ path: "src/main.ts", state: "renamed", from: "src/app.ts" }]);

      const first = page.commits.find((commit) => commit.subject === "Add the app")!;
      const initial = yield* history.detail(root, first.sha);
      assert.deepStrictEqual(initial.files, [{ path: "src/app.ts", state: "added" }]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("diffs a commit's file against its parent, and refuses what isn't a commit", () =>
    Effect.gen(function* () {
      const history = yield* History;
      const { root } = yield* repository;
      const page = yield* history.commits(root, { offset: 0, limit: 10 });
      const fix = page.commits.find((commit) => commit.subject === "Fix login bug")!;
      const diff = yield* history.diff(root, fix.sha, "src/app.ts", undefined, 0);
      assert.deepStrictEqual(diff.hunks, [
        {
          oldStart: 2,
          newStart: 2,
          lines: [
            { kind: "removed", text: "two" },
            { kind: "added", text: "TWO" },
          ],
        },
      ]);
      assert.isFalse(Exit.isFailure(yield* Effect.exit(history.detail(root, fix.sha))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(history.detail(root, "--output=/tmp/x"))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(history.diff(root, fix.sha, "../outside.ts"))));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("Repositories", { timeout: 30_000 }, () => {
  it.effect("makes a folder a repository, and refuses a folder that isn't there", () =>
    Effect.gen(function* () {
      const repositories = yield* Repositories;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* repositories.init(root);
      assert.isTrue(yield* fs.exists(path.join(root, ".git")));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(repositories.init(path.join(root, "missing")))));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a clone address it won't run, before git starts", () =>
    Effect.gen(function* () {
      const repositories = yield* Repositories;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const exit = yield* Effect.exit(Stream.runCollect(repositories.clone("ext::sh -c touch", root)));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
