import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Store } from "@cerium/store";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import { branchFromHead, Projects } from "../src/project.ts";

describe("branchFromHead", () => {
  it("shows a detached HEAD as its short commit", () => {
    expect(branchFromHead("4f1c2a9e0b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e\n")).toBe("4f1c2a9");
  });

  it("reads nothing into a HEAD it doesn't recognise", () => {
    expect(branchFromHead("")).toBeUndefined();
  });
});

const TestLayer = Projects.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Store.layer({ filename: ":memory:" })),
);

describe("Projects", () => {
  it.effect("reads the branch from a subfolder of a repository and from a worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* Projects;
      const root = yield* fs.makeTempDirectoryScoped();

      const repo = path.join(root, "repo");
      yield* fs.makeDirectory(path.join(repo, ".git", "worktrees", "inbox"), { recursive: true });
      yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
      yield* fs.writeFileString(
        path.join(repo, ".git", "worktrees", "inbox", "HEAD"),
        "ref: refs/heads/inbox\n",
      );

      const worktree = path.join(root, "inbox");
      yield* fs.makeDirectory(worktree);
      yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: ../repo/.git/worktrees/inbox\n");

      assert.strictEqual(yield* projects.branch(path.join(repo, "src")), "main");
      assert.strictEqual(yield* projects.branch(worktree), "inbox");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("finds a monorepo package's favicon, and nothing in a folder without one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* Projects;
      const root = yield* fs.makeTempDirectoryScoped();

      const monorepo = path.join(root, "monorepo");
      yield* fs.makeDirectory(path.join(monorepo, "apps", "web", "public"), { recursive: true });
      yield* fs.writeFileString(path.join(monorepo, "apps", "web", "public", "favicon.svg"), "<svg/>");
      const plain = path.join(root, "plain");
      yield* fs.makeDirectory(plain);

      assert.deepStrictEqual(yield* projects.icon(monorepo), {
        mediaType: "image/svg+xml",
        data: "PHN2Zy8+",
      });
      assert.isUndefined(yield* projects.icon(plain));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("saves folders as projects, marks the ones that are gone, and refuses what isn't a folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* Projects;
      const root = yield* fs.makeTempDirectoryScoped();

      const kept = path.join(root, "kept");
      const moved = path.join(root, "moved");
      yield* fs.makeDirectory(kept);
      yield* fs.makeDirectory(moved);
      yield* projects.save(moved);
      yield* TestClock.adjust("1 second");
      yield* projects.save(kept);
      yield* fs.remove(moved, { recursive: true });

      assert.deepStrictEqual(
        (yield* projects.list).map(({ path, missing }) => ({ path, missing })),
        [
          { path: kept, missing: undefined },
          { path: moved, missing: true },
        ],
      );

      const file = path.join(root, "notes.txt");
      yield* fs.writeFileString(file, "");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(projects.save(file))));

      yield* projects.remove(moved);
      assert.deepStrictEqual(
        (yield* projects.list).map((project) => project.path),
        [kept],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
