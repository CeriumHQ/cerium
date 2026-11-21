import { openUsageTerminal, scratchFolder, type SubscriptionReport } from "@cerium/harness";
import { Clock, Duration, Effect, Option } from "effect";

import { signedOut } from "./catalog.ts";
import { failure } from "./rpc.ts";
import { readGrokUsageScreen } from "./usageScreen.ts";

// Grok Build's subscription usage limit, read from its TUI `/usage` panel in a headless PTY.
// ACP exposes the subscription tier name but not the weekly pool percentage or reset time.

const POLL = Duration.millis(200);
const SETTLE = 800;
const DEADLINE = Duration.seconds(25);

/** Reads Grok Build's subscription limits from its interactive `/usage` panel. */
export const readGrokUsage = Effect.fn("GrokAdapter.usage")(function* (executable: string) {
  // An isolated folder of its own so directory trust only applies to this empty scratch directory.
  const cwd = yield* scratchFolder("grok", "cerium-grok-usage");
  const term = yield* openUsageTerminal({
    provider: "grok",
    file: executable,
    args: ["--no-auto-update"],
    cwd,
    env: {
      ...process.env,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      NO_OPEN_BROWSER: "1",
    },
    replyCpr: true,
    startErrorMessage: "Couldn't start Grok Build",
  });

  let trusted = false;
  let promptSince: number | undefined;
  let typed = false;
  let ran = false;

  const read = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(POLL);
      if (term.isExited()) return yield* failure("Grok Build closed before it showed its usage.");
      const now = yield* Clock.currentTimeMillis;
      const state = readGrokUsageScreen(yield* term.screen, now);
      switch (state._tag) {
        case "Trust":
          if (!trusted) {
            term.write("y");
            trusted = true;
          }
          break;
        case "Prompt":
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
          return yield* signedOut();
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
          failure(typed ? "Grok Build didn't show its usage in time." : "Grok Build didn't start in time."),
        ),
    }),
  );
}, Effect.scoped);
