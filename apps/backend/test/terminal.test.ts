import type { ThreadId } from "@cerium/protocol";
import type { TerminalId, TerminalOutput, TerminalSize } from "@cerium/rpc";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Scope, Stream } from "effect";
import { homedir } from "node:os";

import { MAX_PER_THREAD, reachableUrl, Terminals, type TerminalServed } from "../src/terminal.ts";
import { Ptys, type SpawnOptions } from "../src/terminalPty.ts";
import { openScreen } from "../src/terminalScreen.ts";

// The Terminals service over a pseudoterminal that is a puppet, so what the shell prints and when it
// ends is up to the test. The screen is the real emulator.

interface Puppet {
  readonly options: SpawnOptions;
  readonly written: Array<string>;
  readonly resizes: Array<readonly [number, number]>;
  killed: boolean;
  /** What the shell prints. */
  readonly print: (data: string) => void;
  readonly end: (exitCode: number) => void;
}

const puppets = () => {
  const spawned: Array<Puppet> = [];
  const layer = Layer.succeed(
    Ptys,
    Ptys.of({
      spawn: (options, events) =>
        Effect.sync(() => {
          const puppet: Puppet = {
            options,
            written: [],
            resizes: [],
            killed: false,
            print: events.onData,
            end: (exitCode) => events.onExit({ exitCode }),
          };
          spawned.push(puppet);
          return {
            write: (data) => puppet.written.push(data),
            resize: (cols, rows) => puppet.resizes.push([cols, rows]),
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
  return { spawned, layer };
};

const size: TerminalSize = { cols: 80, rows: 24 };
const shell = { file: "puppet", args: ["-x"], name: "Puppet" };

const withTerminals = (options: { readonly backlog?: number; readonly redrawMs?: number } = {}) => {
  const { spawned, layer } = puppets();
  return {
    spawned,
    provide: <A, E>(
      effect: Effect.Effect<A, E, Terminals | Store | FileSystem.FileSystem | Path.Path | Scope.Scope>,
    ) =>
      effect.pipe(
        Effect.provide(
          Terminals.layer({ version: "test", shell, batchMs: 0, ...options }).pipe(
            Layer.provide(layer),
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Store.layer({ filename: ":memory:" })),
          ),
        ),
        Effect.scoped,
      ),
  };
};

const at = (id: string) => id as ThreadId;
const settle = Effect.sleep("40 millis");

/** A work thread whose folder is a fresh temporary one. */
const workThread = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    yield* store.createThread({ id: at(id), title: id, mode: "work", cwd, createdAt: 1, updatedAt: 1 });
    return cwd;
  });

/** Collects what a viewer is sent. */
const watch = (terminals: Terminals["Service"], id: TerminalId) =>
  Effect.gen(function* () {
    const seen: Array<TerminalOutput> = [];
    const fiber = yield* terminals.attach(id, size).pipe(
      Stream.runForEach((output) => Effect.sync(() => void seen.push(output))),
      Effect.forkChild,
    );
    return { seen, fiber };
  });

const text = (outputs: ReadonlyArray<TerminalOutput>) =>
  outputs
    .flatMap((output) => (output._tag === "Exit" || output._tag === "Url" ? [] : [output.data]))
    .join("");

describe("Terminals.open", () => {
  it.live("starts the shell in the thread's folder, set up as a terminal", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const cwd = yield* workThread("thr_a");
        const info = yield* terminals.open(at("thr_a"), size);
        assert.strictEqual(info.threadId, "thr_a");
        assert.strictEqual(info.shell, "Puppet");
        assert.strictEqual(info.cwd, (yield* Path.Path).resolve(cwd));
        assert.isUndefined(info.exitCode);
        const [puppet] = spawned;
        assert.strictEqual(puppet?.options.file, "puppet");
        assert.deepStrictEqual(puppet?.options.args, ["-x"]);
        assert.strictEqual(puppet?.options.cwd, info.cwd);
        assert.strictEqual(puppet?.options.cols, 80);
        assert.strictEqual(puppet?.options.env["TERM"], "xterm-256color");
        assert.strictEqual(puppet?.options.env["TERM_PROGRAM_VERSION"], "test");
        assert.deepStrictEqual(
          (yield* terminals.list).map((each) => each.id),
          [info.id],
        );
      }),
    );
  });

  it.live("refuses a thread that is missing, a chat, or has no usable folder", () => {
    const { provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const store = yield* Store;
        const fs = yield* FileSystem.FileSystem;
        const refused = (threadId: string) =>
          terminals.open(at(threadId), size).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

        assert.strictEqual(yield* refused("thr_none"), "That thread doesn't exist.");

        yield* store.createThread({
          id: at("thr_chat"),
          title: "c",
          mode: "chat",
          createdAt: 1,
          updatedAt: 1,
        });
        assert.strictEqual(yield* refused("thr_chat"), "Only work threads have a terminal.");

        yield* store.createThread({
          id: at("thr_bare"),
          title: "b",
          mode: "work",
          createdAt: 1,
          updatedAt: 1,
        });
        assert.strictEqual(yield* refused("thr_bare"), "Only work threads have a terminal.");

        const root = yield* fs.makeTempDirectoryScoped();
        const missing = `${root}/gone`;
        yield* store.createThread({
          id: at("thr_gone"),
          title: "g",
          mode: "work",
          cwd: missing,
          createdAt: 1,
          updatedAt: 1,
        });
        assert.include(yield* refused("thr_gone"), "doesn't exist");

        const file = `${root}/file.txt`;
        yield* fs.writeFileString(file, "x");
        yield* store.createThread({
          id: at("thr_file"),
          title: "f",
          mode: "work",
          cwd: file,
          createdAt: 1,
          updatedAt: 1,
        });
        assert.include(yield* refused("thr_file"), "isn't a folder");

        assert.deepStrictEqual(yield* terminals.list, []);
      }),
    );
  });

  it.live("caps a thread's terminals", () => {
    const { provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        yield* workThread("thr_b");
        for (let each = 0; each < MAX_PER_THREAD; each++) yield* terminals.open(at("thr_a"), size);
        const error = yield* terminals.open(at("thr_a"), size).pipe(Effect.flip);
        assert.include(error.message, `${MAX_PER_THREAD} terminals`);
        // Another thread has its own.
        yield* terminals.open(at("thr_b"), size);
        assert.strictEqual((yield* terminals.list).length, MAX_PER_THREAD + 1);
      }),
    );
  });
});

describe("Terminals.openProject", () => {
  it.live("starts the shell in the project's folder, listed under the project, and restarts it there", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const project = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const info = yield* terminals.openProject(project, size);
        assert.strictEqual(info.project, project);
        assert.isUndefined(info.threadId);
        assert.strictEqual(info.cwd, (yield* Path.Path).resolve(project));
        assert.strictEqual(spawned[0]?.options.cwd, info.cwd);
        assert.deepStrictEqual(
          (yield* terminals.list).map((each) => each.id),
          [info.id],
        );
        spawned[0]?.end(0);
        yield* settle;
        const again = yield* terminals.restart(info.id, size);
        assert.strictEqual(again.run, 2);
        assert.strictEqual(again.project, project);
      }),
    );
  });

  it.live("refuses a folder that doesn't exist", () => {
    const { provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const error = yield* terminals.openProject("/no/such/folder/here", size).pipe(Effect.flip);
        assert.include(error.message, "doesn't exist");
      }),
    );
  });
});

describe("Terminals.attach", () => {
  it.live("sends the screen as it stands, then what the shell prints, until it ends with its code", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        const [puppet] = spawned;
        puppet?.print("before\r\n");
        yield* settle;

        const viewer = yield* watch(terminals, id);
        yield* settle;
        const first = viewer.seen[0];
        assert.strictEqual(first?._tag, "Screen");
        assert.include(first?._tag === "Screen" ? first.data : "", "before");

        puppet?.print("one ");
        yield* settle;
        puppet?.print("two");
        yield* settle;
        assert.deepStrictEqual(viewer.seen.slice(1), [
          { _tag: "Data", data: "one " },
          { _tag: "Data", data: "two" },
        ]);

        puppet?.end(3);
        yield* Fiber.join(viewer.fiber);
        assert.deepStrictEqual(viewer.seen.at(-1), { _tag: "Exit", code: 3 });
        assert.strictEqual((yield* terminals.list)[0]?.exitCode, 3);
      }),
    );
  });

  it.live("hands a viewer that arrives after the shell ended its last screen and the code", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        spawned[0]?.print("done\r\n");
        spawned[0]?.end(0);
        yield* settle;
        const viewer = yield* watch(terminals, id);
        yield* Fiber.join(viewer.fiber);
        assert.strictEqual(viewer.seen.length, 2);
        assert.include(text(viewer.seen), "done");
        assert.deepStrictEqual(viewer.seen[1], { _tag: "Exit", code: 0 });
      }),
    );
  });

  it.live("gives a viewer that fell behind the screen again instead of a gap", () => {
    const { spawned, provide } = withTerminals({ backlog: 4 });
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        const gate = yield* Deferred.make<void>();
        const seen: Array<TerminalOutput> = [];
        // The viewer holds up on its first piece until released.
        const fiber = yield* terminals.attach(id, size).pipe(
          Stream.mapEffect((output) =>
            seen.length === 0 ? Deferred.await(gate).pipe(Effect.as(output)) : Effect.succeed(output),
          ),
          Stream.runForEach((output) => Effect.sync(() => void seen.push(output))),
          Effect.forkChild,
        );
        yield* settle;
        for (let line = 1; line <= 20; line++) spawned[0]?.print(`line ${line}\r\n`);
        yield* settle;
        yield* Deferred.succeed(gate, undefined);
        yield* settle;
        spawned[0]?.print("after\r\n");
        yield* settle;
        spawned[0]?.end(0);
        yield* Fiber.join(fiber);

        const screens = seen.filter((output) => output._tag === "Screen");
        assert.isAtLeast(screens.length, 2);
        const resynced = seen.findIndex((output, index) => index > 0 && output._tag === "Screen");
        const screen = seen[resynced];
        assert.include(screen?._tag === "Screen" ? screen.data : "", "line 20");
        // Nothing is lost or repeated around the redraw: what follows it is only what came after it.
        assert.include(text(seen.slice(resynced + 1)), "after");
        assert.notInclude(text(seen.slice(resynced + 1)), "line 20");
      }),
    );
  });

  it("draws a screen once for every viewer that asks before it changes", async () => {
    const screen = await openScreen(size);
    screen.write("one\r\n");
    const first = screen.snapshot();
    assert.strictEqual(screen.snapshot(), first);
    assert.include(await first, "one");
    assert.strictEqual(screen.snapshot(), first);
    screen.write("two\r\n");
    const second = screen.snapshot();
    assert.notStrictEqual(second, first);
    assert.include(await second, "two");
    screen.resize(100, 30);
    const third = screen.snapshot();
    assert.notStrictEqual(third, second);
    await third;
    screen.reset();
    assert.notStrictEqual(screen.snapshot(), third);
    assert.notInclude(await screen.snapshot(), "two");
    screen.dispose();
  });

  it.live("draws the screen again for a viewer that keeps falling behind no oftener than it is told", () => {
    const { spawned, provide } = withTerminals({ backlog: 4, redrawMs: 400 });
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        // The viewer holds up on each screen it is drawn until that screen's gate opens.
        const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const screens: Array<{ readonly data: string; readonly at: number }> = [];
        const fiber = yield* terminals.attach(id, size).pipe(
          Stream.mapEffect((output) => {
            if (output._tag !== "Screen") return Effect.void;
            screens.push({ data: output.data, at: performance.now() });
            const gate = gates[screens.length - 1];
            return gate === undefined ? Effect.void : Deferred.await(gate);
          }),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* settle;
        for (let line = 1; line <= 20; line++) spawned[0]?.print(`first ${line}\r\n`);
        yield* settle;
        yield* Deferred.succeed(gates[0]!, undefined);
        yield* settle;
        for (let line = 1; line <= 20; line++) spawned[0]?.print(`second ${line}\r\n`);
        yield* settle;
        yield* Deferred.succeed(gates[1]!, undefined);
        yield* Effect.sleep("600 millis");
        spawned[0]?.end(0);
        yield* Fiber.join(fiber);

        assert.lengthOf(screens, 3);
        assert.include(screens[1]!.data, "first 20");
        assert.include(screens[2]!.data, "second 20");
        assert.isAtLeast(screens[2]!.at - screens[1]!.at, 380);
      }),
    );
  });

  it.live("resizes the terminal to the viewer's size", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        const viewer = yield* terminals
          .attach(id, { cols: 120, rows: 40 })
          .pipe(Stream.runDrain, Effect.forkChild);
        yield* settle;
        assert.deepStrictEqual(spawned[0]?.resizes, [[120, 40]]);
        yield* terminals.resize(id, { cols: 120, rows: 40 });
        assert.strictEqual(spawned[0]?.resizes.length, 1);
        yield* Fiber.interrupt(viewer);
      }),
    );
  });
});

describe("Terminals input and lifecycle", () => {
  it.live("types into the shell, and ignores typing once it has ended", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        yield* terminals.write(id, "ls\r");
        assert.deepStrictEqual(spawned[0]?.written, ["ls\r"]);
        spawned[0]?.end(0);
        yield* terminals.write(id, "late");
        assert.deepStrictEqual(spawned[0]?.written, ["ls\r"]);
        const error = yield* terminals.write("term_none" as TerminalId, "x").pipe(Effect.flip);
        assert.strictEqual(error.message, "That terminal has closed.");
      }),
    );
  });

  it.live("restarts a terminal whose shell ended, on its tab and with a clear screen", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        const running = yield* terminals.restart(id, size).pipe(Effect.flip);
        assert.strictEqual(running.message, "That terminal is still running.");

        spawned[0]?.print("old output\r\n");
        spawned[0]?.end(2);
        yield* settle;
        const info = yield* terminals.restart(id, size);
        assert.strictEqual(info.id, id);
        assert.strictEqual(info.run, 2);
        assert.isUndefined(info.exitCode);
        assert.strictEqual(spawned.length, 2);
        assert.strictEqual(spawned[1]?.options.cwd, spawned[0]?.options.cwd);

        const viewer = yield* watch(terminals, id);
        yield* settle;
        assert.notInclude(text(viewer.seen), "old output");
        yield* Fiber.interrupt(viewer.fiber);
      }),
    );
  });

  it.live("closes a terminal: the shell is ended, viewers are told, and the list forgets it", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        const viewer = yield* watch(terminals, id);
        yield* settle;
        yield* terminals.close(id);
        yield* Fiber.join(viewer.fiber);
        assert.isTrue(spawned[0]?.killed);
        assert.deepStrictEqual(viewer.seen.at(-1), { _tag: "Exit" });
        assert.deepStrictEqual(yield* terminals.list, []);
        const again = yield* terminals.close(id).pipe(Effect.flip);
        assert.strictEqual(again.message, "That terminal has closed.");
      }),
    );
  });

  it.live("closes every terminal of a thread that goes", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        yield* workThread("thr_b");
        yield* terminals.open(at("thr_a"), size);
        yield* terminals.open(at("thr_a"), size);
        yield* terminals.open(at("thr_b"), size);
        yield* terminals.closeThread(at("thr_a"));
        assert.deepStrictEqual(
          (yield* terminals.list).map((each) => each.threadId),
          [at("thr_b")],
        );
        assert.deepStrictEqual(
          spawned.map((each) => each.killed),
          [true, true, false],
        );
      }),
    );
  });

  it.live("ends every terminal when the backend stops", () => {
    const { spawned, provide } = withTerminals();
    return Effect.gen(function* () {
      yield* provide(
        Effect.gen(function* () {
          const terminals = yield* Terminals;
          yield* workThread("thr_a");
          yield* terminals.open(at("thr_a"), size);
          yield* terminals.open(at("thr_a"), size);
          assert.deepStrictEqual(
            spawned.map((each) => each.killed),
            [false, false],
          );
        }),
      );
      assert.deepStrictEqual(
        spawned.map((each) => each.killed),
        [true, true],
      );
    });
  });

  it.live("streams the list of terminals as it changes", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const counts: Array<string> = [];
        const watcher = yield* terminals.changes.pipe(
          Stream.runForEach((list) =>
            Effect.sync(() => void counts.push(list.map((each) => each.exitCode ?? "running").join(","))),
          ),
          Effect.forkChild,
        );
        yield* settle;
        const { id } = yield* terminals.open(at("thr_a"), size);
        yield* settle;
        spawned[0]?.end(4);
        yield* settle;
        yield* terminals.close(id);
        yield* settle;
        yield* Fiber.interrupt(watcher);
        assert.deepStrictEqual(counts, ["", "running", "4", ""]);
      }),
    );
  });
});

describe("Terminals.output", () => {
  it.live("reads the last lines as plain text, colours and rewritten lines applied", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        spawned[0]?.print(
          "\u001b[32mready\u001b[0m in 120 ms\r\nprogress 10%\rprogress 100%\r\n\r\nlast line\r\n\r\n",
        );
        const all = yield* terminals.output(id, 50);
        assert.strictEqual(all.text, "ready in 120 ms\nprogress 100%\n\nlast line");
        assert.strictEqual((yield* terminals.output(id, 2)).text, "\nlast line");
        assert.isUndefined(all.url);
      }),
    );
  });

  it.live("joins a line the terminal wrapped, and reads a terminal whose shell has ended", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), { cols: 10, rows: 5 });
        spawned[0]?.print("0123456789abcdef\r\nnext\r\n");
        spawned[0]?.end(1);
        assert.strictEqual((yield* terminals.output(id, 2)).text, "0123456789abcdef\nnext");
      }),
    );
  });

  it.live("gives the first local address the output printed, reachable from a browser", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* workThread("thr_a");
        const { id } = yield* terminals.open(at("thr_a"), size);
        spawned[0]?.print("listening on http://0.0.0.0:3000/\r\nalso http://localhost:3001\r\n");
        assert.strictEqual((yield* terminals.output(id, 10)).url, "http://localhost:3000/");
      }),
    );
  });

  it.live("refuses a terminal that has closed", () => {
    const { provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const error = yield* terminals.output("term_none" as TerminalId, 10).pipe(Effect.flip);
        assert.strictEqual(error.message, "That terminal has closed.");
      }),
    );
  });
});

describe("Terminals.served", () => {
  const collect = (terminals: Terminals["Service"]) =>
    Effect.gen(function* () {
      const seen: Array<TerminalServed> = [];
      const fiber = yield* terminals.served.pipe(
        Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
        Effect.forkChild,
      );
      yield* settle;
      return { seen, fiber };
    });

  it.live("tells a script's first address once per run, and again after the run starts over", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const cwd = yield* workThread("thr_a");
        const { seen, fiber } = yield* collect(terminals);
        const { id } = yield* terminals.openScript(at("thr_a"), "Run", shell, cwd, size);
        spawned[0]?.print("VITE ready\r\n  Local: http://localhost:5173/\r\n");
        spawned[0]?.print("and http://localhost:5174/ too\r\n");
        yield* settle;
        assert.deepStrictEqual(seen, [
          { id, threadId: "thr_a", script: "Run", url: "http://localhost:5173/" },
        ]);

        spawned[0]?.end(0);
        yield* terminals.restart(id, size);
        spawned[1]?.print("Local: http://localhost:5173/\r\n");
        yield* settle;
        assert.strictEqual(seen.length, 2);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  it.live("leaves plain shells alone, and finds an address cut across two pieces of output", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const cwd = yield* workThread("thr_a");
        const { seen, fiber } = yield* collect(terminals);
        yield* terminals.open(at("thr_a"), size);
        spawned[0]?.print("http://localhost:4000\r\n");
        yield* terminals.openScript(at("thr_a"), "Run", shell, cwd, size);
        spawned[1]?.print("at http://local");
        yield* settle;
        spawned[1]?.print("host:4000/app\r\n");
        yield* settle;
        assert.deepStrictEqual(
          seen.map((event) => event.url),
          ["http://localhost:4000/app"],
        );
        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});

describe("reachableUrl", () => {
  it("opens a server that listens everywhere at the machine's own name, and leaves other addresses", () => {
    assert.strictEqual(reachableUrl("http://0.0.0.0:3000/x"), "http://localhost:3000/x");
    assert.strictEqual(reachableUrl("https://0.0.0.0"), "https://localhost");
    assert.strictEqual(reachableUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    assert.strictEqual(reachableUrl("http://localhost:5173/"), "http://localhost:5173/");
  });
});

describe("Terminals.run", () => {
  it.live("runs the program in the home folder, unlisted, and replaces the earlier run of it", () => {
    const { spawned, provide } = withTerminals();
    return provide(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        const program = { file: "/bin/claude", args: ["auth", "login"], name: "claude" };
        const first = yield* terminals.run("claude:login", program, size);
        const [puppet] = spawned;
        assert.strictEqual(puppet?.options.file, "/bin/claude");
        assert.deepStrictEqual(puppet?.options.args, ["auth", "login"]);
        assert.strictEqual(puppet?.options.cwd, homedir());
        assert.deepStrictEqual(yield* terminals.list, []);

        const { seen } = yield* watch(terminals, first.id);
        yield* settle;
        puppet?.print("Opening the browser");
        yield* settle;
        assert.include(text(seen), "Opening the browser");

        const second = yield* terminals.run("claude:login", program, size);
        assert.notStrictEqual(second.id, first.id);
        assert.isTrue(puppet?.killed);
        const restarted = yield* terminals.restart(second.id, size).pipe(Effect.flip);
        assert.strictEqual(restarted.message, "That command has ended. Run it again instead.");
      }),
    );
  });
});
