import type { CapabilityManifest } from "@cerium/protocol";

// Google's official, separately authenticated ACP runtime, not Gemini CLI, an API wrapper, or the
// undocumented `agy acp` entry point. Official distribution and custom-client support:
// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
// https://antigravity.google/docs/changelog (IDE Extensions, initial ACP server release).
export const INSTALL_HINT =
  "Install Google's Antigravity ACP runtime from https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json. " +
  "Extract both the ACP executable and its matching localharness_external helper into the same folder, " +
  "add it to PATH (or set CERIUM_ANTIGRAVITY_PATH), then sign in here. The agy CLI has a separate sign-in.";

export const antigravityManifest: CapabilityManifest = {
  provider: "antigravity",
  session: { resume: true, fork: false },
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  // No supported switch disables its native batch subagents. Cerium's instructions ask it to use
  // the bus; that instruction is not an enforcement mechanism.
  nativeSubagents: "notDisableable",
  usageReporting: "tokens",
  compact: false,
  defaultConcurrency: 4,
};
