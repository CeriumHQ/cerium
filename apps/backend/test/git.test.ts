import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { explainGit, Git, gitComplaint, shownOutput } from "../src/git.ts";
import { sameFolder } from "./repositories.ts";

describe("git's words", () => {
  it("says another git holds the index, whatever else it printed", () => {
    expect(
      explainGit(
        "fatal: Unable to create 'C:/work/app/.git/index.lock': File exists.\n\nAnother git process seems to be running",
        "fallback",
      ),
    ).toMatch(/^Another git process is working in this repository/);
  });

  it("asks for a name and email when git doesn't know who commits", () => {
    expect(
      explainGit(
        '*** Please tell me who you are.\n\n  git config --global user.email "you@example.com"',
        "x",
      ),
    ).toMatch(/^Git doesn't know who you are yet/);
  });

  it("falls back to git's own last complaint, then to what the caller says", () => {
    expect(gitComplaint("warning: x\nerror: pathspec 'a' did not match any file(s) known to git")).toBe(
      "Pathspec 'a' did not match any file(s) known to git.",
    );
    expect(explainGit("husky - pre-commit hook exited with code 1", "A hook stopped it.")).toBe(
      "A hook stopped it.",
    );
  });

  it("keeps what git and its hooks printed, errors first", () => {
    expect(shownOutput({ stdout: "out\r\n", stderr: "  err\n" })).toBe("err\nout");
    expect(shownOutput({ stdout: "", stderr: "" })).toBe("");
  });
});

const TestLayer = Git.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("Git", () => {
  it.effect("finds where a folder sits in its repository, and nothing outside one", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      assert.isUndefined(yield* git.repository(root));
      yield* git.change(root, ["init", "-q", "-b", "main"], { fallback: "Couldn't init." });
      yield* git.forget(root);
      yield* fs.makeDirectory(path.join(root, "apps", "ui"), { recursive: true });
      const below = yield* git.repository(path.join(root, "apps", "ui"));
      assert.isDefined(below);
      assert.strictEqual(below.prefix, "apps/ui/");
      assert.isTrue(sameFolder(root, below.top));
      assert.strictEqual(path.relative(below.gitDir, below.commonDir), "");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("fails a change with git's complaint and what it printed", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* git.change(root, ["init", "-q"], { fallback: "Couldn't init." });
      const exit = yield* Effect.exit(
        git.change(root, ["add", "--", "missing.txt"], { fallback: "Couldn't add." }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
        assert.match(error?.message ?? "", /missing\.txt/);
        assert.match(error?.output ?? "", /missing\.txt/);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reads stdin, and takes paths as written", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* git.change(root, ["init", "-q"], { fallback: "Couldn't init." });
      yield* fs.writeFileString(path.join(root, "a.txt"), "a");
      yield* fs.writeFileString(path.join(root, "b.txt"), "b");
      // A star is a name here, not a pattern: nothing is called that.
      const star = yield* git.run(root, ["add", "--", "*.txt"]);
      assert.notStrictEqual(star.code, 0);
      yield* git.change(root, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: "a.txt\0",
        fallback: "Couldn't add.",
      });
      const listed = yield* git.run(root, ["diff", "--cached", "--name-only"], { look: true });
      assert.strictEqual(listed.stdout.trim(), "a.txt");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
