import type { AcpHarness } from "@cerium/acp";
import { HarnessFailure } from "@cerium/harness";
import type { CapabilityManifest } from "@cerium/protocol";

export const PROVIDER = "antigravity";
export const MINIMUM_VERSION = "1.5.0";
export const LOGIN_COMMAND = "agy acp --login";
export const INSTALL_HINT =
  "Install Antigravity CLI from https://antigravity.google/docs/cli-install, then run `agy acp --login`.";
export const SIGNED_OUT = "Antigravity is not signed in. Run `agy acp --login`.";

export const antigravityHarness: AcpHarness = {
  provider: PROVIDER,
  label: "Antigravity",
  installHint: INSTALL_HINT,
  loginCommand: LOGIN_COMMAND,
  signedOut: SIGNED_OUT,
};

export const failure = (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: PROVIDER, message, cause });

export const antigravityManifest: CapabilityManifest = {
  provider: PROVIDER,
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  // Plan mode adds planning instructions. It does not enforce Cerium's read-only boundary.
  permissions: { approvals: "protocol", readOnlyMode: false },
  mcpInjection: true,
  nativeSubagents: "notDisableable",
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
