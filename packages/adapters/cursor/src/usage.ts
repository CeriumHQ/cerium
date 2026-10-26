import { tmpdir } from "node:os";

import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { Terminal } from "@xterm/headless";
import { Clock, Deferred, Duration, Effect, Exit, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { IPty } from "node-pty";

import { hasUsageCommand, MIN_USAGE_VERSION, readUsageScreen } from "./usageScreen.ts";

// The plan's limits as the user's Cursor CLI shows them in its `/usage` panel. The SDK has no call for
// them, so the CLI runs in a pseudoterminal nobody sees, is asked for `/usage`, and its screen is read
// (usageScreen.ts). The CLI fetches the usage with its own login, which Cerium never touches.

/** Wide enough for the panel's table rather than its narrow list. */
const COLUMNS = 140;
const ROWS = 50;

/** How often the screen is read while the CLI starts and loads the panel. */
const POLL = Duration.millis(200);

/** How long the prompt stays up before `/usage` is typed, so the input has mounted to take it. */
const SETTLE = 1_000;

/** Within the backend's own 30 seconds, so the reason given is this one. */
const DEADLINE = Duration.seconds(25);

/** How long the CLI gets to end once its processes were ended, before its pseudoterminal is closed. */
const GRACE = Duration.millis(1_500);

const SIGN_IN = "Sign the Cursor CLI in with `cursor-agent login` to see Cursor's limits here.";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "cursor", message, cause });
const unreadable = (message: string) => new HarnessFailure({ provider: "cursor", message, cause: null });

interface Cli {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** The user's `cursor-agent`, as the program and arguments that start it. */
const findCli = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const candidates = yield* spawner
    .lines(ChildProcess.make(windows ? "where" : "which", ["cursor-agent"]))
    .pipe(
      Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "")),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
  for (const candidate of candidates) {
    if (!windows || path.extname(candidate).toLowerCase() === ".exe") {
      return Option.some<Cli>({ file: candidate, args: [] });
    }
    // The installer's `cursor-agent.cmd` runs the PowerShell script beside it; starting the script the
    // same way keeps cmd.exe's quoting out of the arguments.
    const script = path.join(path.dirname(candidate), "cursor-agent.ps1");
    if (yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false))) {
      const powershell = path.join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      return Option.some<Cli>({
        file: powershell,
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      });
    }
  }
  return Option.none<Cli>();
});

// Both are CommonJS: Node finds their exports under `default`, and a bundler may not.
type Loaded<T> = T & { readonly default?: T };

/** The pseudoterminal and the emulator that reads its screen, loaded on the first read. */
const loadTerminal = Effect.tryPromise({
  try: async () => {
    const pty = (await import("node-pty")) as unknown as Loaded<typeof import("node-pty")>;
    const headless = (await import("@xterm/headless")) as unknown as Loaded<{ Terminal: typeof Terminal }>;
    return { spawn: (pty.default ?? pty).spawn, Terminal: (headless.default ?? headless).Terminal };
  },
  catch: failure("Couldn't open a terminal to run the Cursor CLI in"),
});

/** Ends the CLI and everything it started: its process tree on Windows, its process group elsewhere. */
const endCli = (pty: IPty, gone: Deferred.Deferred<void>) =>
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

/** Asks the user's Cursor CLI for its `/usage`: `None` when the plan has no usage it can show. */
export const readCursorUsage = Effect.fn("CursorAdapter.usage")(function* () {
  const cli = yield* findCli;
  if (Option.isNone(cli)) {
    return yield* unreadable(
      "Cursor reports its limits through its CLI. Install it and sign in with `cursor-agent login` to see them here.",
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A folder of its own, so the workspace trust the CLI records is for this one folder only.
  const cwd = path.join(tmpdir(), "cerium-cursor-usage");
  yield* fs
    .makeDirectory(cwd, { recursive: true })
    .pipe(Effect.mapError(failure("Couldn't prepare the Cursor CLI's folder")));

  const native = yield* loadTerminal;
  const terminal = yield* Effect.acquireRelease(
    Effect.sync(() => new native.Terminal({ cols: COLUMNS, rows: ROWS, allowProposedApi: true })),
    (terminal) => Effect.sync(() => terminal.dispose()),
  );
  const gone = Deferred.makeUnsafe<void>();
  const pty = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        native.spawn(cli.value.file, [...cli.value.args, "--trust"], {
          name: "xterm-256color",
          cols: COLUMNS,
          rows: ROWS,
          cwd,
          env: { ...process.env, NO_OPEN_BROWSER: "1" } as Record<string, string>,
        }),
      catch: failure("Couldn't start the Cursor CLI"),
    }),
    (pty) => endCli(pty, gone),
  );
  pty.onData((data) => terminal.write(data));
  pty.onExit(() => Deferred.doneUnsafe(gone, Exit.void));

  /** The screen after everything the CLI printed so far, line by line. */
  const screen = Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        terminal.write("", () => {
          const buffer = terminal.buffer.active;
          const lines: Array<string> = [];
          for (let row = 0; row < buffer.length; row++)
            lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
          resolve(lines.join("\n"));
        });
      }),
  );

  let promptSince: number | undefined;
  let typed = false;
  let ran = false;
  const read = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(POLL);
      if (Deferred.isDoneUnsafe(gone))
        return yield* unreadable("The Cursor CLI closed before it showed its usage.");
      const now = yield* Clock.currentTimeMillis;
      const state = readUsageScreen(yield* screen, now);
      switch (state._tag) {
        case "Prompt":
          if (state.version !== undefined && !hasUsageCommand(state.version)) {
            return yield* unreadable(
              `Cursor CLI ${state.version} can't report its limits; ${MIN_USAGE_VERSION} or later can. Update it with \`cursor-agent update\`.`,
            );
          }
          promptSince ??= now;
          if (!typed && now - promptSince >= SETTLE) {
            pty.write("/usage");
            typed = true;
          }
          break;
        case "Offered":
          if (!ran) {
            pty.write("\r");
            ran = true;
          }
          break;
        case "Report":
          return Option.some<SubscriptionReport>(state.report);
        case "NoPlan":
          return Option.none<SubscriptionReport>();
        case "LoggedOut":
          return yield* unreadable(SIGN_IN);
        case "Failed":
          return yield* unreadable(state.message);
        case "Waiting":
          break;
      }
    }
  });
  return yield* read.pipe(
    Effect.timeoutOrElse({
      duration: DEADLINE,
      orElse: () =>
        Effect.fail(
          unreadable(
            typed
              ? "The Cursor CLI didn't show its usage in time."
              : `The Cursor CLI didn't start in time. ${SIGN_IN}`,
          ),
        ),
    }),
  );
}, Effect.scoped);
