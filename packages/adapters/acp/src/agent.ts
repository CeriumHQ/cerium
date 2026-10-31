import { HarnessFailure } from "@cerium/harness";
import { Effect } from "effect";

import { isAuthError, openAcpConnection, type AcpConnection, type WireFrame } from "./connection.ts";
import type { AcpCommand, AcpHarness, AcpLaunch } from "./harness.ts";

// An agent process for one purpose, signed in the way its harness asks: every session, probe, listing
// and completion starts here, so `initialize` and the sign-in step are the same for all of them.

export interface OpenedAgent {
  readonly connection: AcpConnection;
  readonly command: AcpCommand;
  /** False when the agent needs an interactive login, or refused the stored credential. */
  readonly signedIn: boolean;
  /** Why the sign-in failed, in the agent's words. */
  readonly signInError?: string;
}

/** Starts the agent for `launch` and signs it in. The process ends with the enclosing scope. */
export const openAcpAgent = Effect.fn("AcpAgent.open")(function* (
  harness: AcpHarness,
  executablePath: string,
  launch: AcpLaunch,
  record?: (frame: WireFrame) => void,
) {
  const command = harness.command(launch);
  const connection = yield* openAcpConnection({
    provider: harness.provider,
    name: harness.name,
    command: executablePath,
    args: command.args,
    cwd: launch.cwd,
    ...(command.env === undefined ? {} : { env: command.env }),
    ...(command.initializeMeta === undefined ? {} : { initializeMeta: command.initializeMeta }),
    ...(record === undefined ? {} : { record }),
  });
  const signIn = harness.signIn?.(connection.initialized) ?? { _tag: "Ready" as const };
  switch (signIn._tag) {
    case "Ready":
      return { connection, command, signedIn: true } satisfies OpenedAgent;
    case "SignedOut":
      return { connection, command, signedIn: false } satisfies OpenedAgent;
    case "Authenticate": {
      const answered = yield* connection
        .request("authenticate", {
          methodId: signIn.methodId,
          ...(signIn.meta === undefined ? {} : { _meta: { ...signIn.meta } }),
        })
        .pipe(Effect.result);
      if (answered._tag === "Success") return { connection, command, signedIn: true } satisfies OpenedAgent;
      const error = answered.failure;
      if (isAuthError(error) || error.code === -32602) {
        return { connection, command, signedIn: false, signInError: error.message } satisfies OpenedAgent;
      }
      return yield* new HarnessFailure({
        provider: harness.provider,
        message: `${harness.name} couldn't sign in: ${error.message}`,
        cause: error,
      });
    }
  }
});
