import type { AcpHarness } from "@cerium/acp";
import { HarnessFailure } from "@cerium/harness";
import type { CapabilityManifest } from "@cerium/protocol";

export const PROVIDER = "grok";
export const INSTALL_HINT = "Install Grok Build from https://docs.x.ai/build/overview.";
export const LOGIN_COMMAND = "grok login";
export const SIGNED_OUT = `Grok Build is not signed in. Run \`${LOGIN_COMMAND}\`.`;

export const failure = (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: PROVIDER, message, cause });

export const grokHarness: AcpHarness = {
  provider: PROVIDER,
  label: "Grok Build",
  installHint: INSTALL_HINT,
  loginCommand: LOGIN_COMMAND,
  signedOut: SIGNED_OUT,
  // Grok's error messages and data can include local auth or configuration details. Keep the code.
  refused: (_method, error) => failure(`Grok Build rejected the ACP request (${error.code})`, error.code),
};

export const grokManifest: CapabilityManifest = {
  provider: PROVIDER,
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  permissions: { approvals: "hookBridge", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
