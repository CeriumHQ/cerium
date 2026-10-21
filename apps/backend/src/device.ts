import { Installation, MAX_DEVICE_NAME, randomToken, type Channel, type DeviceDraft } from "@cerium/protocol";
import { RPC_VERSION } from "@cerium/rpc";
import { Schema } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** How this machine describes itself when it signs in: its name on the network, until renamed. */
export const thisMachine = (channel: Channel, version: string): DeviceDraft => ({
  kind: "desktop",
  name: hostname().trim().slice(0, MAX_DEVICE_NAME).trim() || "This PC",
  platform: process.platform,
  channel,
  version: version.trim() || "dev",
  rpcVersion: RPC_VERSION,
});

const isInstallation = Schema.is(Installation);

/**
 * This install, kept in its data folder beside the sign-in but not with it: signing out forgets the
 * sign-in, and signing in again is still this machine, not another one.
 */
export const thisInstallation = (dataDirectory: string): Installation => {
  const file = join(dataDirectory, "installation");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (isInstallation(saved)) return saved;
  } catch {
    // None yet.
  }
  const fresh = randomToken(16);
  try {
    writeFileSync(file, fresh);
  } catch {
    // Unsaved, the next sign-in after a restart adds the machine again; nothing else is lost.
  }
  return fresh;
};
