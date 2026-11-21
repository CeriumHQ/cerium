import type { AcpHarness } from "@cerium/acp";
import { HarnessFailure } from "@cerium/harness";
import type { CapabilityManifest } from "@cerium/protocol";

export const PROVIDER = "devin";
export const LOGIN_COMMAND = "devin auth login";
export const INSTALL_HINT =
  "Install the Devin CLI (curl -fsSL https://cli.devin.ai/install.sh | bash), then run `devin auth login`.";
export const SIGNED_OUT = "Devin is not signed in. Run `devin auth login`.";

export const devinHarness: AcpHarness = {
  provider: PROVIDER,
  label: "Devin",
  installHint: INSTALL_HINT,
  loginCommand: LOGIN_COMMAND,
  signedOut: SIGNED_OUT,
};

export const failure = (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: PROVIDER, message, cause });

export const devinManifest: CapabilityManifest = {
  provider: PROVIDER,
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false, speed: true },
  input: { images: true },
  // Ask mode withholds Devin's write and shell tools; the adapter refuses every other approval.
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  // Each session runs on a Cerium copy of the user's config with `subagents_enabled` off.
  nativeSubagents: "disableable",
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
