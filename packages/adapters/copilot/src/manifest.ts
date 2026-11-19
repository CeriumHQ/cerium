import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "copilot login";
export const SIGN_IN = `GitHub Copilot CLI is not signed in. Run \`${LOGIN_COMMAND}\`.`;
export const INSTALL_HINT =
  "Install GitHub Copilot CLI from https://github.com/github/copilot-cli, then run `copilot login`.";

export const copilotManifest: CapabilityManifest = {
  provider: "copilot",
  releases: { npmPackage: "@github/copilot", updateCommand: "copilot update" },
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  // Copilot's cost field is a billing multiplier, not USD.
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
