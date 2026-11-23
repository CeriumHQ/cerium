import { hostname } from "node:os";
import { join } from "node:path";
import { readRuntimeStatus, type RuntimeStatus } from "@cerium/backend/runtime";
import { readSavedSignIn, savedStatus } from "@cerium/backend/headless";

export function hostStatus(
  saved: string | undefined,
  runtime: RuntimeStatus | undefined,
  relayUrl: string,
  installed: boolean,
) {
  const signIn = savedStatus(saved, { relayUrl, deviceName: runtime?.name ?? hostname() });
  return {
    signedIn: signIn.signedIn,
    account: signIn.text.replace("Run with --sign-in", "Run cerium-host login"),
    serviceInstalled: installed,
    running: runtime !== undefined,
    online: runtime?.connection === "online",
    runtime: runtime ?? null,
  };
}

export function status(dataDirectory: string, relay: string, installed: boolean) {
  return hostStatus(
    readSavedSignIn(join(dataDirectory, "account.json")),
    readRuntimeStatus(dataDirectory),
    relay,
    installed,
  );
}
