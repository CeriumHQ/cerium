import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "claude auth login";
export const INSTALL_HINT =
  "Install Claude Code from https://claude.com/claude-code, then run `claude auth login`.";

/** Built-in tools that spawn native subagents; Cerium's bus is the only way to spawn. */
export const NATIVE_SUBAGENT_TOOLS = ["Agent", "Workflow", "SendMessage"] as const;

export const claudeManifest: CapabilityManifest = {
  provider: "claude",
  // Raise `testedMaximum` after re-recording fixtures and re-running the live smoke test.
  harnessVersion: { minimum: "2.1.301", testedMaximum: "2.1.302" },
  session: { resume: true, fork: true },
  // Effort switches mid-session through `applyFlagSettings({ effortLevel })`. The smoke test shows the
  // prompt cache surviving the switch (turn 2 after medium → low: 53 new vs 33.6k cached input tokens).
  switching: { model: true, effort: true, cacheSafeEffort: true },
  input: { images: true },
  permissions: { approvals: "callback", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  usageReporting: "tokensAndCost",
  defaultConcurrency: 6,
};
