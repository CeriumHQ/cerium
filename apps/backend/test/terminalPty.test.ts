import { execFileSync } from "node:child_process";

import type { ThreadId } from "@cerium/protocol";
import type { TerminalOutput } from "@cerium/rpc";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { Terminals } from "../src/terminal.ts";
import { Ptys } from "../src/terminalPty.ts";
import { ThreadEnv } from "../src/threadEnv.ts";

// The same service on a real pseudoterminal (ConPTY on Windows), with Node itself as the shell so the
// test needs nothing installed: it echoes what it's typed, starts a child that outlives it, and exits
// with a code on request.

const script = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("child:" + child.pid + ":end");
process.stdin.on("data", (data) => {
  console.log("got:" + data.toString().trim());
  if (data.toString().includes("q")) process.exit(7);
});
`;

const shell = { file: process.execPath, args: ["-e", script], name: "node" };
const size = { cols: 100, rows: 30 };

const layer = Terminals.layer({ version: "test", shell }).pipe(
  Layer.provide(Ptys.layer),
  Layer.provide(ThreadEnv.layer({ free: () => Promise.resolve(true) })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Store.layer({ filename: ":memory:" })),
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The console hosts ConPTY runs for this process's pseudoterminals, Windows' own or node-pty's. */
const consoleHosts = () =>
  Number(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object Name -in 'conhost.exe','OpenConsole.exe').Count`,
      ],
      { encoding: "utf8" },
    ).trim(),
  );

/** Polls the terminal's screen until `done` holds for its text, or fails after a while. */
const screenUntil = (
  terminals: Terminals["Service"],
  id: Parameters<Terminals["Service"]["attach"]>[0],
  done: (text: string) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 60; attempt++) {
      const [screen] = yield* terminals.attach(id, size).pipe(Stream.take(1), Stream.runCollect);
      const text = screen?._tag === "Screen" ? screen.data : "";
      if (done(text)) return text;
      yield* Effect.sleep("250 millis");
    }
    return yield* Effect.die("The terminal never showed what was expected.");
  });

const openTerminal = Effect.gen(function* () {
  const store = yield* Store;
  const terminals = yield* Terminals;
  const threadId = "thr_pty" as ThreadId;
  yield* store.createThread({
    id: threadId,
    title: "pty",
    mode: "work",
    cwd: process.cwd(),
    createdAt: 1,
    updatedAt: 1,
  });
  const info = yield* terminals.open(threadId, size);
  return { terminals, id: info.id };
});

describe("Terminals on a real pseudoterminal", () => {
  it.live(
    "shows what the shell prints and what is typed, and reports its exit code",
    () =>
      Effect.gen(function* () {
        const { terminals, id } = yield* openTerminal;
        yield* screenUntil(terminals, id, (text) => text.includes("child:"));
        yield* terminals.write(id, "hello\r");
        yield* screenUntil(terminals, id, (text) => text.includes("got:hello"));
        yield* terminals.write(id, "q\r");
        const seen: Array<TerminalOutput> = yield* terminals.attach(id, size).pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        );
        assert.deepStrictEqual(seen.at(-1), { _tag: "Exit", code: 7 });
        assert.strictEqual((yield* terminals.list)[0]?.exitCode, 7);
      }).pipe(Effect.provide(layer), Effect.scoped),
    60_000,
  );

  it.live(
    "ends the shell's whole process tree when the terminal closes",
    () =>
      Effect.gen(function* () {
        const { terminals, id } = yield* openTerminal;
        const text = yield* screenUntil(terminals, id, (shown) => /child:\d+:end/.test(shown));
        const child = Number(/child:(\d+):end/.exec(text)?.[1]);
        assert.isTrue(alive(child));
        yield* terminals.close(id);
        for (let attempt = 0; attempt < 40 && alive(child); attempt++) yield* Effect.sleep("100 millis");
        assert.isFalse(alive(child));
      }).pipe(Effect.provide(layer), Effect.scoped),
    60_000,
  );

  it.live.runIf(process.platform === "win32")(
    "leaves no console host behind once the shell exits",
    () =>
      Effect.gen(function* () {
        const before = consoleHosts();
        const { terminals, id } = yield* openTerminal;
        yield* screenUntil(terminals, id, (text) => text.includes("child:"));
        yield* terminals.write(id, "q\r");
        yield* terminals.attach(id, size).pipe(Stream.runDrain);
        let left = consoleHosts();
        for (let attempt = 0; attempt < 20 && left > before; attempt++) {
          yield* Effect.sleep("250 millis");
          left = consoleHosts();
        }
        assert.strictEqual(left, before);
      }).pipe(Effect.provide(layer), Effect.scoped),
    60_000,
  );

  it.live(
    "leaves no shell behind when the backend stops",
    () =>
      Effect.gen(function* () {
        let child = 0;
        yield* Effect.gen(function* () {
          const { terminals, id } = yield* openTerminal;
          const text = yield* screenUntil(terminals, id, (shown) => /child:\d+:end/.test(shown));
          child = Number(/child:(\d+):end/.exec(text)?.[1]);
          assert.isTrue(alive(child));
        }).pipe(Effect.provide(layer), Effect.scoped);
        for (let attempt = 0; attempt < 40 && alive(child); attempt++) yield* Effect.sleep("100 millis");
        assert.isFalse(alive(child));
      }),
    60_000,
  );
});
