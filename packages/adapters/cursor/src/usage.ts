import {
  findOnPath,
  HarnessFailure,
  openUsageTerminal,
  scratchFolder,
  type SubscriptionReport,
} from "@cerium/harness";
import { Clock, Duration, Effect, FileSystem, Option, Path } from "effect";

import { hasUsageCommand, MIN_USAGE_VERSION, readUsageScreen } from "./usageScreen.ts";

// The plan's limits as the user's Cursor CLI shows them in its `/usage` panel. The SDK has no call for
// them, so the CLI runs in a pseudoterminal nobody sees, is asked for `/usage`, and its screen is read
// (usageScreen.ts). The CLI fetches the usage with its own login, which Cerium never touches.

/** How often the screen is read while the CLI starts and loads the panel. */
const POLL = Duration.millis(200);

/** How long the prompt stays up before `/usage` is typed, so the input has mounted to take it. */
const SETTLE = 1_000;

/** Within the backend's own 30 seconds, so the reason given is this one. */
const DEADLINE = Duration.seconds(25);

const SIGN_IN = "Sign the Cursor CLI in with `cursor-agent login` to see Cursor's limits here.";

const unreadable = (message: string) => new HarnessFailure({ provider: "cursor", message, cause: null });

interface Cli {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** The user's `cursor-agent`, as the program and arguments that start it. */
const findCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const candidates = yield* findOnPath("cursor-agent");
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

/** Asks the user's Cursor CLI for its `/usage`: `None` when the plan has no usage it can show. */
export const readCursorUsage = Effect.fn("CursorAdapter.usage")(function* () {
  const cli = yield* findCli;
  if (Option.isNone(cli)) {
    return yield* unreadable(
      "Cursor reports its limits through its CLI. Install it and sign in with `cursor-agent login` to see them here.",
    );
  }
  // A folder of its own, so the workspace trust the CLI records is for this one folder only, and one
  // no other user can put a `.cursor` folder in.
  const cwd = yield* scratchFolder("cursor", "cerium-cursor-usage");
  const term = yield* openUsageTerminal({
    provider: "cursor",
    file: cli.value.file,
    args: [...cli.value.args, "--trust"],
    cwd,
    env: { ...process.env, NO_OPEN_BROWSER: "1" },
    startErrorMessage: "Couldn't start the Cursor CLI",
  });

  let promptSince: number | undefined;
  let typed = false;
  let ran = false;
  const read = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(POLL);
      if (term.isExited()) return yield* unreadable("The Cursor CLI closed before it showed its usage.");
      const now = yield* Clock.currentTimeMillis;
      const state = readUsageScreen(yield* term.screen, now);
      switch (state._tag) {
        case "Prompt":
          if (state.version !== undefined && !hasUsageCommand(state.version)) {
            return yield* unreadable(
              `Cursor CLI ${state.version} can't report its limits; ${MIN_USAGE_VERSION} or later can. Update it with \`cursor-agent update\`.`,
            );
          }
          promptSince ??= now;
          if (!typed && now - promptSince >= SETTLE) {
            term.write("/usage");
            typed = true;
          }
          break;
        case "Offered":
          if (!ran) {
            term.write("\r");
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
