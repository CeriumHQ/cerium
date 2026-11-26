import type { Terminal } from "@xterm/headless";
import { Deferred, Duration, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { IPty } from "node-pty";

import { HarnessFailure } from "./adapter.ts";

// A headless pseudoterminal backed by @xterm/headless, for reading interactive CLI panels like `/usage`.

/** How long a CLI gets to end once its processes were ended, before its pseudoterminal is closed. */
const GRACE = Duration.millis(1_500);

// Both are CommonJS: Node finds their exports under `default`, and a bundler may not.
type Loaded<T> = T & { readonly default?: T };

const loadTerminal = (provider: string) =>
  Effect.tryPromise({
    try: async () => {
      const pty = (await import("node-pty")) as unknown as Loaded<typeof import("node-pty")>;
      const headless = (await import("@xterm/headless")) as unknown as Loaded<{ Terminal: typeof Terminal }>;
      return { spawn: (pty.default ?? pty).spawn, Terminal: (headless.default ?? headless).Terminal };
    },
    catch: (cause) =>
      new HarnessFailure({
        provider,
        message: "Couldn't open a terminal to read usage",
        cause,
      }),
  });

/** Ends the CLI and everything it started: its process tree on Windows, its process group elsewhere. */
const endProcess = (pty: IPty, gone: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    if (Deferred.isDoneUnsafe(gone)) return;
    if (process.platform === "win32") {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner
        .exitCode(
          ChildProcess.make("taskkill", ["/pid", String(pty.pid), "/T", "/F"], {
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.ignore);
    } else {
      yield* Effect.try(() => process.kill(-pty.pid, "SIGKILL")).pipe(Effect.ignore);
    }
    yield* Deferred.await(gone).pipe(Effect.timeoutOption(GRACE));
    if (!Deferred.isDoneUnsafe(gone)) yield* Effect.try(() => pty.kill()).pipe(Effect.ignore);
  });

export interface UsageTerminalOptions {
  readonly provider: string;
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cols?: number;
  readonly rows?: number;
  /** Answer ANSI cursor-position queries (`ESC[6n`) so TUIs that probe cursor position don't stall. */
  readonly replyCpr?: boolean;
  readonly startErrorMessage?: string;
}

export interface UsageTerminal {
  readonly write: (data: string) => void;
  /** The screen after everything the CLI printed so far, line by line. */
  readonly screen: Effect.Effect<string>;
  readonly isExited: () => boolean;
}

/**
 * Starts a CLI inside a headless pseudoterminal and tears down its entire process tree when the
 * enclosing scope closes.
 */
export const openUsageTerminal = Effect.fn("Harness.openUsageTerminal")(function* (
  options: UsageTerminalOptions,
) {
  const cols = options.cols ?? 140;
  const rows = options.rows ?? 50;
  const native = yield* loadTerminal(options.provider);
  const terminal = yield* Effect.acquireRelease(
    Effect.sync(() => new native.Terminal({ cols, rows, allowProposedApi: true })),
    (term) => Effect.sync(() => term.dispose()),
  );
  const gone = Deferred.makeUnsafe<void>();
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const pty = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        native.spawn(options.file, [...options.args], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: options.cwd,
          env,
          // The ConPTY node-pty ships. Windows' own leaves its `conhost.exe` running after the CLI
          // exits, because node-pty never closes a console whose process ended: one every read.
          useConptyDll: true,
        }),
      catch: (cause) =>
        new HarnessFailure({
          provider: options.provider,
          message: options.startErrorMessage ?? "Couldn't start the CLI",
          cause,
        }),
    }),
    (handle) => endProcess(handle, gone),
  );

  pty.onData((data) => {
    terminal.write(data);
    if (options.replyCpr && data.includes("\x1b[6n")) {
      try {
        pty.write("\x1b[1;1R");
      } catch {
        // Process already exited.
      }
    }
  });
  pty.onExit(() => Deferred.doneUnsafe(gone, Exit.void));

  const screen = Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        terminal.write("", () => {
          const buffer = terminal.buffer.active;
          const lines: Array<string> = [];
          for (let row = 0; row < buffer.length; row++) {
            lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
          }
          resolve(lines.join("\n"));
        });
      }),
  );

  return {
    write: (data: string) => pty.write(data),
    screen,
    isExited: () => Deferred.isDoneUnsafe(gone),
  } satisfies UsageTerminal;
});
