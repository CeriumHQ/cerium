import { ProjectScripts } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Scope } from "effect";

import { projectScriptsLayer } from "../src/projectScripts.ts";
import { Terminals } from "../src/terminal.ts";
import { Ptys } from "../src/terminalPty.ts";
import { ThreadEnv } from "../src/threadEnv.ts";

// A project's commands as the service resolves them from its folder, the user's saved word and its
// `.cerium.toml`, and what writing them into the file does to what was saved. Terminals are real,
// over a pseudoterminal that does nothing.

const idle = Layer.succeed(
  Ptys,
  Ptys.of({
    spawn: () =>
      Effect.succeed({
        write: () => undefined,
        resize: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        kill: Effect.void,
      }),
  }),
);

const shell = { file: "puppet", args: ["-x"], name: "Puppet" };
const size = { cols: 80, rows: 24 };

const TestLayer = (() => {
  const terminals = Terminals.layer({ version: "test", shell, batchMs: 0 }).pipe(
    Layer.provide(idle),
    Layer.provideMerge(ThreadEnv.layer({ free: () => Promise.resolve(true) })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Store.layer({ filename: ":memory:" })),
  );
  return projectScriptsLayer.pipe(Layer.provideMerge(terminals));
})();

const withScripts = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ProjectScripts | Terminals | Store | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.scoped);

/** A project folder holding `files`, a name and its text each. */
const project = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped();
    for (const [name, text] of Object.entries(files))
      yield* fs.writeFileString(path.join(folder, name), text);
    return folder;
  });

const FILE =
  '[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n\n[actions]\ntest = "bun test"\nLint = "bun run lint"\nrun = "reserved"\nTEST = "taken"\n';

describe("ProjectScripts.resolve", () => {
  it.effect("offers the file's actions, leaving out names that are taken or a script's own", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const folder = yield* project({ ".cerium.toml": FILE });
        assert.deepStrictEqual(yield* scripts.resolve(folder), {
          setup: { text: "bun install", from: "project" },
          run: { text: "bun run dev", from: "project" },
          actions: [
            { name: "test", text: "bun test", from: "project" },
            { name: "Lint", text: "bun run lint", from: "project" },
          ],
        });
      }),
    ),
  );

  it.effect("puts the user's saved list in place of the file's, whole", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const store = yield* Store;
        const folder = yield* project({ ".cerium.toml": FILE });
        yield* store.writeProjectScripts(folder, {
          setup: null,
          run: null,
          actions: [
            { name: " Migrate ", command: "bun run migrate" },
            { name: "Nothing", command: " " },
          ],
        });
        assert.deepStrictEqual((yield* scripts.resolve(folder)).actions, [
          { name: "Migrate", text: "bun run migrate", from: "saved" },
        ]);
        // An empty saved list is the user turning every action off.
        yield* store.writeProjectScripts(folder, { setup: null, run: null, actions: [] });
        assert.deepStrictEqual((yield* scripts.resolve(folder)).actions, []);
      }),
    ),
  );
});

describe("ProjectScripts.writeFile", () => {
  it.effect("makes the file, and clears what was saved so the file is what resolves", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const store = yield* Store;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* project({
          "package-lock.json": "{}",
          "package.json": '{"scripts":{"dev":"vite"}}',
        });
        yield* store.writeProjectScripts(folder, {
          setup: "pnpm install",
          run: "",
          actions: [{ name: "Old", command: "x" }],
        });
        yield* scripts.writeFile({
          project: folder,
          setup: " npm ci ",
          run: "",
          actions: [{ name: "Test", command: 'npm test -- --grep "a b"' }],
        });
        assert.strictEqual(
          yield* fs.readFileString(path.join(folder, ".cerium.toml")),
          '[scripts]\nsetup = "npm ci"\n\n[actions]\nTest = \'npm test -- --grep "a b"\'\n',
        );
        // The emptied run stays off, as the package's dev script would be guessed back in; setup defers.
        const saved = (yield* store.listProjects).find((each) => each.path === folder);
        assert.deepStrictEqual(
          { setup: saved?.setup, run: saved?.run, actions: saved?.actions },
          { setup: null, run: "", actions: null },
        );
        assert.deepStrictEqual(yield* scripts.resolve(folder), {
          setup: { text: "npm ci", from: "project" },
          actions: [{ name: "Test", text: 'npm test -- --grep "a b"', from: "project" }],
        });
      }),
    ),
  );

  it.effect("changes only its sections of a file that has more in it", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* project({
          ".cerium.toml":
            '# ours\r\n[scripts]\r\nrun = "old"\r\nteardown = "rm -rf tmp"\r\n\r\n[meta]\r\nowner = "team"\r\n',
        });
        yield* scripts.writeFile({ project: folder, setup: "", run: "new", actions: [] });
        assert.strictEqual(
          yield* fs.readFileString(path.join(folder, ".cerium.toml")),
          '# ours\r\n[scripts]\r\nrun = "new"\r\nteardown = "rm -rf tmp"\r\n\r\n[meta]\r\nowner = "team"\r\n',
        );
      }),
    ),
  );

  it.effect("refuses names that can't tell the actions apart, writing nothing", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* project({});
        const refused = yield* Effect.flip(
          scripts.writeFile({
            project: folder,
            setup: "",
            run: "",
            actions: [
              { name: "Test", command: "a" },
              { name: "test", command: "b" },
            ],
          }),
        );
        assert.match(refused.message, /taken/);
        assert.isFalse(yield* fs.exists(path.join(folder, ".cerium.toml")));
      }),
    ),
  );
});

describe("ProjectScripts.startAction", () => {
  it.effect("runs an action in a terminal of the thread's own, labelled with its name", () =>
    withScripts(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const terminals = yield* Terminals;
        const store = yield* Store;
        const folder = yield* project({ ".cerium.toml": FILE });
        const threadId = "t1" as ThreadId;
        yield* store.createThread({
          id: threadId,
          title: "t",
          mode: "work",
          cwd: folder,
          createdAt: 1,
          updatedAt: 1,
        });

        const ran = yield* scripts.startAction({
          name: "lint",
          threadId,
          project: folder,
          cwd: folder,
          size,
        });
        assert.deepStrictEqual(ran, { name: "Lint", text: "bun run lint", from: "project" });
        const labels = (yield* terminals.list)
          .filter((info) => info.threadId === threadId)
          .map((info) => info.script);
        assert.deepStrictEqual(labels, ["Lint"]);

        // The same action again takes the place of its terminal.
        yield* scripts.startAction({ name: "Lint", threadId, project: folder, cwd: folder, size });
        assert.strictEqual((yield* terminals.list).filter((info) => info.threadId === threadId).length, 1);

        const missing = yield* Effect.flip(
          scripts.startAction({ name: "Deploy", threadId, project: folder, cwd: folder, size }),
        );
        assert.match(missing.message, /no Deploy action/);
      }),
    ),
  );
});
