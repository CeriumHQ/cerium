import { ProjectScripts } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Scope, Stream } from "effect";

import {
  guessScripts,
  outputTail,
  projectScriptsLayer,
  scriptsFromToml,
  teardownFailure,
} from "../src/projectScripts.ts";
import { Terminals } from "../src/terminal.ts";
import { ThreadEnv } from "../src/threadEnv.ts";

// What a project's `.cerium.toml` holds as scripts, what the guess makes of its package manager, and
// how a teardown runs and fails.

describe("scriptsFromToml", () => {
  it("reads the project's setup and run", () => {
    expect(scriptsFromToml('[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n')).toEqual({
      setup: "bun install",
      run: "bun run dev",
    });
  });

  it("reads the teardown beside them", () => {
    expect(scriptsFromToml('[scripts]\nsetup = "bun install"\nteardown = "docker compose down"\n')).toEqual({
      setup: "bun install",
      teardown: "docker compose down",
    });
  });

  it("reads single quotes and drops comments after a command", () => {
    expect(scriptsFromToml("[scripts]\nrun = 'cargo run' # keep it going")).toEqual({ run: "cargo run" });
  });

  it("takes only the top-level scripts section", () => {
    expect(
      scriptsFromToml(
        '[profile.dev]\nrun = "wrong"\n[scripts]\nrun = "right"\n[scripts.more]\nsetup = "wrong"\n',
      ),
    ).toEqual({ run: "right" });
  });

  it("reads a file that Windows wrote with a byte-order mark", () => {
    expect(scriptsFromToml('﻿[scripts]\nsetup = "bun install"\n')).toEqual({ setup: "bun install" });
  });

  it("reads nothing from a file without a scripts section", () => {
    expect(scriptsFromToml('[package]\nname = "x"\nrun = "bun run dev"\n')).toEqual({});
  });
});

describe("guessScripts", () => {
  it("guesses the package manager's install and its dev script", () => {
    expect(guessScripts(["package-lock.json", "package.json"], '{"scripts":{"dev":"vite"}}')).toEqual({
      setup: "npm install",
      run: "npm run dev",
    });
  });

  it("guesses from the package alone when there is no lockfile", () => {
    expect(guessScripts(["package.json"], '{"scripts":{"start":"node ."}}')).toEqual({
      setup: "npm install",
      run: "npm run start",
    });
  });

  it("guesses for python and go projects, which install differently", () => {
    expect(guessScripts(["uv.lock"])).toEqual({ setup: "uv sync" });
    expect(guessScripts(["go.mod"])).toEqual({ setup: "go mod download", run: "go run ." });
  });

  it("guesses nothing for a project none of its kinds fit", () => {
    expect(guessScripts(["README.md"])).toEqual({});
  });

  it("never guesses a teardown", () => {
    expect(guessScripts(["bun.lock", "package.json"], '{"scripts":{"dev":"vite"}}')).not.toHaveProperty(
      "teardown",
    );
  });
});

describe("outputTail", () => {
  it("keeps the last few lines of output, without colour codes or blank lines", () => {
    expect(outputTail("one\n\n\u001b[31mtwo\u001b[0m\nthree\r\nfour\n")).toBe("two · three · four");
  });

  it("cuts a long tail from the front", () => {
    const tail = outputTail("x".repeat(500));
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBe(301);
  });
});

describe("teardownFailure", () => {
  it("says how it ended, then what it last said", () => {
    expect(teardownFailure({ code: 3 }, "cleaning up\nbroke\n")).toBe(
      "exited with code 3: cleaning up · broke",
    );
    expect(teardownFailure({ timedOut: true }, "")).toBe("ran longer than 60 seconds and was stopped");
    expect(teardownFailure({ cannotStart: "no such shell" }, "")).toBe("couldn't start: no such shell");
  });
});

// Teardown runs for real, through the shell a script runs in, in a project folder of its own.

const withScripts = <A, E>(
  effect: Effect.Effect<A, E, ProjectScripts | Store | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  effect.pipe(
    Effect.provide(
      projectScriptsLayer.pipe(
        Layer.provide(Layer.succeed(Terminals, { changes: Stream.empty } as unknown as Terminals["Service"])),
        Layer.provide(ThreadEnv.layer({ free: () => Promise.resolve(true) })),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Store.layer({ filename: ":memory:" })),
      ),
    ),
    Effect.scoped,
  );

/** A project folder holding two tiny programs, and a work thread running in a worktree of it. */
const withThread = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* Store;
  const project = yield* fs.makeTempDirectoryScoped();
  const worktree = yield* fs.makeTempDirectoryScoped();
  const threadId = "thr_teardown" as ThreadId;
  for (const folder of [project, worktree]) {
    yield* fs.writeFileString(
      path.join(folder, "fail.js"),
      "console.log('cleaning up'); console.error('the database is gone'); process.exit(3);\n",
    );
    yield* fs.writeFileString(
      path.join(folder, "env.js"),
      "require('fs').writeFileSync('env.txt', [process.env.CERIUM_THREAD_ID, process.env.CERIUM_ROOT_PATH, process.env.CERIUM_WORKSPACE_PATH, process.env.CERIUM_PORT].join('|'));\n",
    );
  }
  yield* store.createThread({
    id: threadId,
    title: "Teardown",
    mode: "work",
    cwd: worktree,
    worktree: { project, root: worktree, branch: "cerium/teardown", base: "main" },
    createdAt: 1,
    updatedAt: 1,
  });
  return { fs, path, store, project, worktree, threadId };
});

describe("teardown", () => {
  it.effect("runs the saved command in the worktree with the thread's environment", () =>
    withScripts(
      Effect.gen(function* () {
        const { fs, path, store, project, worktree, threadId } = yield* withThread;
        const scripts = yield* ProjectScripts;
        yield* store.writeProjectScripts(project, { teardown: "node env.js" });
        const failure = yield* scripts.teardown({ threadId, project, cwd: worktree });
        assert.isUndefined(failure);
        const [id, root, workspace, port] = (yield* fs.readFileString(path.join(worktree, "env.txt"))).split(
          "|",
        );
        assert.strictEqual(id, threadId);
        assert.strictEqual(root, project);
        assert.strictEqual(workspace, worktree);
        assert.match(port!, /^\d{5}$/);
        assert.deepStrictEqual(yield* scripts.ports(threadId), {
          first: Number(port),
          last: Number(port) + 9,
        });
      }),
    ),
  );

  it.effect("reports a command that fails with its exit code and what it last said", () =>
    withScripts(
      Effect.gen(function* () {
        const { store, project, worktree, threadId } = yield* withThread;
        const scripts = yield* ProjectScripts;
        yield* store.writeProjectScripts(project, { teardown: "node fail.js" });
        const failure = yield* scripts.teardown({ threadId, project, cwd: worktree });
        assert.strictEqual(failure?.script, "node fail.js");
        // PowerShell's `-Command` reports 1 for a program that failed, whatever code it exited with.
        assert.match(failure?.failure ?? "", /^exited with code [1-9]/);
        assert.include(failure?.failure, "the database is gone");
      }),
    ),
  );

  it.effect("runs nothing when no teardown is set, or the worktree is already gone", () =>
    withScripts(
      Effect.gen(function* () {
        const { fs, path, store, project, worktree, threadId } = yield* withThread;
        const scripts = yield* ProjectScripts;
        assert.isUndefined(yield* scripts.teardown({ threadId, project, cwd: worktree }));
        yield* store.writeProjectScripts(project, { teardown: "node fail.js" });
        assert.isUndefined(yield* scripts.teardown({ threadId, project, cwd: path.join(worktree, "gone") }));
        // The project's own file is read when nothing is saved.
        yield* store.writeProjectScripts(project, { teardown: null });
        yield* fs.writeFileString(
          path.join(project, ".cerium.toml"),
          "[scripts]\nteardown = 'node env.js'\n",
        );
        assert.isUndefined(yield* scripts.teardown({ threadId, project, cwd: worktree }));
        assert.isTrue(yield* fs.exists(path.join(worktree, "env.txt")));
      }),
    ),
  );
});
