import { MAX_DEVICE_NAME, type Channel, type DeviceDraft } from "@cerium/protocol";
import { RPC_VERSION } from "@cerium/rpc";
import { hostname } from "node:os";

/** How this machine describes itself when it signs in: its name on the network, until renamed. */
export const thisMachine = (channel: Channel, version: string): DeviceDraft => ({
  kind: "desktop",
  name: hostname().trim().slice(0, MAX_DEVICE_NAME).trim() || "This PC",
  platform: process.platform,
  channel,
  version: version.trim() || "dev",
  rpcVersion: RPC_VERSION,
});
