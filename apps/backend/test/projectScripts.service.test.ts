import { ProjectScripts, type ScriptEnded, type ScriptServed } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import type { TerminalId, TerminalInfo } from "@cerium/rpc";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, PubSub, Scope, Stream } from "effect";

import { projectScriptsLayer } from "../src/projectScripts.ts";
import { Terminals } from "../src/terminal.ts";
import { Ptys, type SpawnOptions } from "../src/terminalPty.ts";

// The project scripts over the Terminals service, whose shells are puppets: what a run prints and
// when it ends is up to the test. The screens are the real emulator.

interface Puppet {
  readonly options: SpawnOptions;
  killed: boolean;
  readonly print: (data: string) => void;
  readonly end: (exitCode: number) => void;
}

const stack = () => {
  const spawned: Array<Puppet> = [];
  const ptys = Layer.succeed(
    Ptys,
    Ptys.of({
      spawn: (options, events) =>
        Effect.sync(() => {
          const puppet: Puppet = {
            options,
            killed: false,
            print: events.onData,
            end: (exitCode) => events.onExit({ exitCode }),
          };
          spawned.push(puppet);
          return {
            write: () => undefined,
            resize: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            kill: Effect.sync(() => {
              puppet.killed = true;
              events.onExit({ exitCode: 1 });
            }),
          };
        }),
    }),
  );
  const terminals = Terminals.layer({
    version: "test",
    shell: { file: "puppet", args: [], name: "Puppet" },
    batchMs: 0,
  }).pipe(
    Layer.provide(ptys),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Store.layer({ filename: ":memory:" })),
  );
  return {
    spawned,
    provide: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ProjectScripts | Terminals | Store | FileSystem.FileSystem | Path.Path | Scope.Scope
      >,
    ) => effect.pipe(Effect.provide(projectScriptsLayer.pipe(Layer.provideMerge(terminals))), Effect.scoped),
  };
};

const thread = "thr_a" as ThreadId;
const settle = Effect.sleep("100 millis");

/** Waits for a start that runs in a fibre of its own to have opened its shell, however busy the machine is. */
const opened = (spawned: ReadonlyArray<Puppet>, count: number) =>
  Effect.gen(function* () {
    for (let wait = 0; wait < 300 && spawned.length < count; wait++) yield* Effect.sleep("10 millis");
    yield* settle;
  });

/** A work thread in a fresh folder whose project file sets `dev` as its run and `install` as its setup. */
const project = Effect.gen(function* () {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(path.join(cwd, ".cerium.toml"), '[scripts]\nsetup = "install"\nrun = "dev"\n');
  yield* store.createThread({ id: thread, title: "a", mode: "work", cwd, createdAt: 1, updatedAt: 1 });
  return cwd;
});

/** Collects a stream's events while the test runs. */
const collect = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const seen: Array<A> = [];
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
      Effect.forkChild,
    );
    yield* settle;
    return { seen, fiber };
  });

describe("ProjectScripts served", () => {
  it.live("tells where the run serves, once, and not for the setup", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const { seen, fiber } = yield* collect(scripts.served);
        yield* scripts.start({ kind: "setup", threadId: thread, project: cwd, cwd });
        spawned[0]?.print("see http://localhost:9999/docs\r\n");
        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
        spawned[1]?.print("Local: http://localhost:5173/\r\n");
        spawned[1]?.print("Local: http://localhost:5174/\r\n");
        yield* settle;
        assert.deepStrictEqual(seen satisfies ReadonlyArray<ScriptServed>, [
          { threadId: thread, kind: "run", script: "dev", url: "http://localhost:5173/" },
        ]);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  it.live("keeps the first news from the lead when the caller waited for it", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const served = yield* collect(scripts.served);
        const ended = yield* collect(scripts.ended);
        const starting = yield* scripts
          .start({ kind: "run", threadId: thread, project: cwd, cwd, settleWithin: "5 seconds" })
          .pipe(Effect.forkChild);
        yield* opened(spawned, 1);
        spawned[0]?.print("Local: http://localhost:5173/\r\n");
        yield* Fiber.join(starting);
        yield* settle;
        assert.deepStrictEqual(served.seen, []);
        // Only the first news is the caller's: the run failing later reaches the lead.
        spawned[0]?.end(1);
        yield* settle;
        assert.deepStrictEqual(
          ended.seen.map((each) => each.code),
          [1],
        );
        yield* Fiber.interrupt(served.fiber);
        yield* Fiber.interrupt(ended.fiber);
      }),
    );
  });

  it.live("gives a run that ends within the wait to the caller, and the one that is slow to the lead", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const served = yield* collect(scripts.served);
        const ended = yield* collect(scripts.ended);
        const quick = yield* scripts
          .start({ kind: "run", threadId: thread, project: cwd, cwd, settleWithin: "5 seconds" })
          .pipe(Effect.forkChild);
        yield* opened(spawned, 1);
        spawned[0]?.end(3);
        yield* Fiber.join(quick);
        yield* settle;
        assert.deepStrictEqual(ended.seen, []);

        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd, settleWithin: "30 millis" });
        spawned[1]?.print("Local: http://localhost:5173/\r\n");
        yield* settle;
        assert.deepStrictEqual(
          served.seen.map((each) => each.url),
          ["http://localhost:5173/"],
        );
        yield* Fiber.interrupt(served.fiber);
        yield* Fiber.interrupt(ended.fiber);
      }),
    );
  });
});

describe("ProjectScripts waiting callers", () => {
  it.live("leaves the news to the lead when the caller that waited gave up", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const served = yield* collect(scripts.served);
        const starting = yield* scripts
          .start({ kind: "run", threadId: thread, project: cwd, cwd, settleWithin: "30 seconds" })
          .pipe(Effect.forkChild);
        yield* opened(spawned, 1);
        yield* Fiber.interrupt(starting);
        spawned[0]?.print("Local: http://localhost:5173/\r\n");
        yield* settle;
        assert.deepStrictEqual(
          served.seen.map((each) => each.url),
          ["http://localhost:5173/"],
        );
        yield* Fiber.interrupt(served.fiber);
      }),
    );
  });
});

describe("ProjectScripts ended", () => {
  it.live(
    "carries the end of a failed script's output as plain text, and nothing of one that finished",
    () => {
      const { spawned, provide } = stack();
      return provide(
        Effect.gen(function* () {
          const scripts = yield* ProjectScripts;
          const cwd = yield* project;
          const { seen, fiber } = yield* collect(scripts.ended);
          yield* scripts.start({ kind: "setup", threadId: thread, project: cwd, cwd });
          spawned[0]?.print("\u001b[31mnpm ERR!\u001b[0m 404 not found\r\nnpm ERR! missing package\r\n");
          spawned[0]?.end(1);
          yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
          spawned[1]?.print("compiled\r\n");
          spawned[1]?.end(0);
          yield* settle;
          assert.deepStrictEqual(seen satisfies ReadonlyArray<ScriptEnded>, [
            {
              threadId: thread,
              kind: "setup",
              script: "install",
              code: 1,
              output: "npm ERR! 404 not found\nnpm ERR! missing package",
            },
            { threadId: thread, kind: "run", script: "dev", code: 0 },
          ]);
          yield* Fiber.interrupt(fiber);
        }),
      );
    },
  );

  it.live("bounds what a failure carries to its last lines", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const { seen, fiber } = yield* collect(scripts.ended);
        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
        spawned[0]?.print(Array.from({ length: 100 }, (_, line) => `line ${line + 1}`).join("\r\n") + "\r\n");
        spawned[0]?.end(2);
        yield* settle;
        const lines = seen[0]?.output?.split("\n");
        assert.strictEqual(lines?.length, 30);
        assert.strictEqual(lines?.at(0), "line 71");
        assert.strictEqual(lines?.at(-1), "line 100");
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  it.live("doesn't report a run replaced by another, or one stopped on request", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        const { seen, fiber } = yield* collect(scripts.ended);
        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
        assert.isTrue(spawned[0]?.killed);
        assert.isTrue(yield* scripts.stop(thread, "run"));
        assert.isTrue(spawned[1]?.killed);
        yield* settle;
        assert.deepStrictEqual(seen, []);
        assert.isFalse(yield* scripts.stop(thread, "run"));
        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});

describe("ProjectScripts status", () => {
  it.live("reads a thread's run: running with its address and output, then exited with its code", () => {
    const { spawned, provide } = stack();
    return provide(
      Effect.gen(function* () {
        const scripts = yield* ProjectScripts;
        const cwd = yield* project;
        assert.isUndefined(yield* scripts.status(thread, "run", 10));
        yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
        spawned[0]?.print("booting\r\nServing http://0.0.0.0:3000/\r\n");
        assert.deepStrictEqual(yield* scripts.status(thread, "run", 10), {
          running: true,
          url: "http://localhost:3000/",
          output: "booting\nServing http://0.0.0.0:3000/",
        });
        assert.isUndefined(yield* scripts.status(thread, "setup", 10));

        spawned[0]?.end(137);
        assert.deepStrictEqual(yield* scripts.status(thread, "run", 1), {
          running: false,
          exitCode: 137,
          url: "http://localhost:3000/",
          output: "Serving http://0.0.0.0:3000/",
        });
        yield* scripts.stop(thread, "run");
        assert.isUndefined(yield* scripts.status(thread, "run", 10));
      }),
    );
  });
});

describe("ProjectScripts watching a slow read", () => {
  it.live("doesn't take a run started while a failure's output is read for one that is gone", () => {
    let current: ReadonlyArray<TerminalInfo> = [];
    let opened = 0;
    const lists = Effect.runSync(PubSub.unbounded<ReadonlyArray<TerminalInfo>>());
    const gate = Effect.runSync(Deferred.make<void>());
    const show = (next: ReadonlyArray<TerminalInfo>) => {
      current = next;
      PubSub.publishUnsafe(lists, next);
    };
    const info = (id: string, script: string, exitCode?: number): TerminalInfo => ({
      id: id as TerminalId,
      threadId: thread,
      shell: script,
      cwd: "/",
      openedAt: 0,
      run: 1,
      script,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    // Only what the project scripts use of the terminals; what a failed script printed is held back until the gate opens.
    const terminals = Layer.succeed(Terminals, {
      changes: Stream.fromPubSub(lists),
      served: Stream.empty,
      list: Effect.sync(() => current),
      output: () => Deferred.await(gate).pipe(Effect.as({ text: "boom" })),
      openScript: (_thread: ThreadId, script: string) =>
        Effect.sync(() => {
          const one = info(`term_${++opened}`, script);
          show([...current.filter((each) => each.script !== script), one]);
          return one;
        }),
      close: () => Effect.void,
    } as unknown as Terminals["Service"]);
    const layer = projectScriptsLayer.pipe(
      Layer.provideMerge(terminals),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Store.layer({ filename: ":memory:" })),
    );
    return Effect.gen(function* () {
      const scripts = yield* ProjectScripts;
      const cwd = yield* project;
      const { seen, fiber } = yield* collect(scripts.ended);
      yield* scripts.start({ kind: "setup", threadId: thread, project: cwd, cwd });
      // The setup fails, and its output is being read when the run starts: the list that told of the
      // failure is older than the run, which isn't gone for not being on it.
      show([info("term_1", "Setup", 1)]);
      yield* settle;
      yield* scripts.start({ kind: "run", threadId: thread, project: cwd, cwd });
      yield* Deferred.succeed(gate, undefined);
      yield* settle;
      show([info("term_1", "Setup", 1), info("term_2", "Run", 0)]);
      yield* settle;
      assert.deepStrictEqual(
        seen.map((each) => [each.kind, each.code]),
        [
          ["setup", 1],
          ["run", 0],
        ],
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
