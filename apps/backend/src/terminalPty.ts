import { Context, Deferred, Effect, Exit, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { IPty } from "node-pty";

import { taskkillArgs } from "./terminalShell.ts";

// The pseudoterminals under the terminals: Microsoft's node-pty, which uses ConPTY on Windows. It is
// a native module, loaded when the first terminal opens, so a computer it can't load on loses its
// terminals and nothing else.

/** A terminal the backend couldn't serve; `message` is written for the user. */
export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  message: Schema.String,
}) {}

export interface SpawnOptions {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/** What a running shell reports. They arrive outside any fiber: handlers do no more than hand on. */
export interface PtyEvents {
  readonly onData: (data: string) => void;
  /** The shell ended, with the signal that ended it where there was one. */
  readonly onExit: (exit: { readonly exitCode: number; readonly signal?: number | undefined }) => void;
}

export interface Pty {
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** Stops reading the shell's output, so that it waits when its pipe fills. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** Ends the shell and everything it started; resolves once the shell is gone. */
  readonly kill: Effect.Effect<void>;
}

/** How long a shell gets to go once its processes were ended, before the pseudoterminal is closed on it. */
const GRACE = "1500 millis";

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class Ptys extends Context.Service<
  Ptys,
  {
    /** Starts a shell on a new pseudoterminal. */
    spawn(options: SpawnOptions, events: PtyEvents): Effect.Effect<Pty, TerminalError>;
  }
>()("cerium/backend/Ptys") {
  /** Requires `ChildProcessSpawner`, which ends a Windows shell's process tree. */
  static readonly layer = Layer.effect(
    Ptys,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // node-pty is CommonJS: Node finds its functions under `default`, and a bundler may not.
      const loadNative = yield* Effect.cached(
        Effect.tryPromise({
          try: async () => {
            const loaded = (await import("node-pty")) as unknown as typeof import("node-pty") & {
              readonly default?: typeof import("node-pty");
            };
            return loaded.default ?? loaded;
          },
          catch: (cause) =>
            new TerminalError({ message: `Terminals aren't available on this computer: ${reason(cause)}` }),
        }),
      );

      /** The shell and what it started: the process tree on Windows, the shell's process group elsewhere. */
      const killTree = (pty: IPty, gone: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          const pid = pty.pid;
          if (process.platform === "win32") {
            if (pid > 0) {
              yield* spawner
                .exitCode(
                  ChildProcess.make("taskkill", taskkillArgs(pid), { stdout: "ignore", stderr: "ignore" }),
                )
                .pipe(Effect.ignore);
            }
          } else {
            // Hanging up lets an interactive shell hang up its jobs; whatever ignores it is killed.
            yield* Effect.try(() => pty.kill("SIGHUP")).pipe(Effect.ignore);
            yield* Deferred.await(gone).pipe(Effect.timeoutOption(GRACE));
            if (!Deferred.isDoneUnsafe(gone) && pid > 0) {
              yield* Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(Effect.ignore);
            }
          }
          // Releases the pseudoterminal itself, when the shell's end didn't.
          yield* Deferred.await(gone).pipe(Effect.timeoutOption(GRACE));
          if (!Deferred.isDoneUnsafe(gone)) yield* Effect.try(() => pty.kill()).pipe(Effect.ignore);
        });

      return Ptys.of({
        spawn: (options, events) =>
          Effect.gen(function* () {
            const native = yield* loadNative;
            const gone = Deferred.makeUnsafe<void>();
            const pty = yield* Effect.try({
              try: () =>
                native.spawn(options.file, [...options.args], {
                  name: "xterm-256color",
                  cols: options.cols,
                  rows: options.rows,
                  cwd: options.cwd,
                  env: { ...options.env },
                  // The ConPTY node-pty ships. Windows' own leaves its `conhost.exe` running after the
                  // shell exits, because node-pty never closes a console whose process ended.
                  useConptyDll: true,
                }),
              catch: (cause) =>
                new TerminalError({ message: `Couldn't start ${options.file}: ${reason(cause)}` }),
            });
            pty.onData(events.onData);
            pty.onExit((exit) => {
              Deferred.doneUnsafe(gone, Exit.void);
              events.onExit(exit);
            });
            return {
              write: (data) => pty.write(data),
              resize: (cols, rows) => {
                if (!Deferred.isDoneUnsafe(gone)) pty.resize(cols, rows);
              },
              pause: () => pty.pause(),
              resume: () => pty.resume(),
              kill: Effect.suspend(() => (Deferred.isDoneUnsafe(gone) ? Effect.void : killTree(pty, gone))),
            } satisfies Pty;
          }),
      });
    }),
  );
}
