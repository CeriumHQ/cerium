import { HarnessFailure, HarnessUnavailable } from "@cerium/harness";
import type { HarnessStatus, ProviderId } from "@cerium/protocol";
import { Effect } from "effect";

import type { AcpError } from "./errors.ts";

/** What every part of an ACP harness's integration names it by. */
export interface AcpHarness {
  /** The provider id events and failures carry. */
  readonly provider: ProviderId;
  /** How messages name the harness, such as "Antigravity". */
  readonly label: string;
  readonly installHint: string;
  readonly loginCommand: string;
  /** What a signed-out harness tells the user. */
  readonly signedOut: string;
  /**
   * The failure a request the agent refused becomes. By default it names the method, quotes the
   * agent's message and keeps the error as its cause; a harness whose errors can carry local auth or
   * configuration details may keep only the code.
   */
  readonly refused?: (method: string, error: AcpError) => HarnessFailure;
}

export const harnessFailure = (harness: AcpHarness) => (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: harness.provider, message, cause });

export const loginRequired = (harness: AcpHarness) =>
  new HarnessUnavailable({ provider: harness.provider, reason: "loggedOut", message: harness.signedOut });

export const requireExecutable = (harness: AcpHarness, executable: string | undefined) =>
  executable === undefined
    ? Effect.fail(
        new HarnessUnavailable({
          provider: harness.provider,
          reason: "notInstalled",
          message: harness.installHint,
        }),
      )
    : Effect.succeed(executable);

/** The installed, signed-in status, or the `HarnessUnavailable` that says why there is none. */
export const usableStatus = (harness: AcpHarness, status: HarnessStatus) =>
  Effect.gen(function* () {
    if (status._tag === "HarnessMissing") {
      return yield* new HarnessUnavailable({
        provider: harness.provider,
        reason: "notInstalled",
        message: harness.installHint,
      });
    }
    if (status.auth._tag === "LoggedOut") return yield* loginRequired(harness);
    return status;
  });
