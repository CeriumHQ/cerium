import type { CapabilityManifest } from "@cerium/protocol";

export const INSTALL_HINT = "Install Grok Build from https://docs.x.ai/build/overview.";
export const LOGIN_COMMAND = "grok login";
export const SIGNED_OUT = `Grok Build is not signed in. Run \`${LOGIN_COMMAND}\`.`;

export const grokManifest: CapabilityManifest = {
  provider: "grok",
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  permissions: { approvals: "hookBridge", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
