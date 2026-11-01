import type { CapabilityManifest } from "@cerium/protocol";

// Grok Build's own agent server, `grok agent stdio`, speaks the Agent Client Protocol: each Cerium
// session runs on a process of its own, with Grok's documented `session/new` `_meta` options (`rules`,
// `yoloMode`, `autoMode`) and its `x.ai/` extensions. Sessions are Grok's own: they show in the user's
// Grok history, and theirs can be resumed and read here.

export const LOGIN_COMMAND = "grok login";
export const INSTALL_HINT =
  process.platform === "win32"
    ? "Install Grok Build (`irm https://x.ai/cli/install.ps1 | iex` in PowerShell), then run `grok login`."
    : "Install Grok Build (`curl -fsSL https://x.ai/cli/install.sh | bash`), then run `grok login`.";

export const grokManifest: CapabilityManifest = {
  provider: "grok",
  releases: { npmPackage: "@xai-official/grok", updateCommand: "grok update" },
  // `session/resume` continues a session without replaying it. `x.ai/session/fork` copies one whole, but
  // rewinding the copy to a turn fails over ACP, so a fork could not stop before a turn.
  session: { resume: true, fork: false },
  // `reasoning_effort` changes the effort without touching the prompt, yet the next request misses the
  // prompt cache (measured: 1.6k of 18.8k input tokens cached after a switch, 18.4k without).
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  // Tool calls Grok would ask about arrive as `session/request_permission`; `yoloMode: false` keeps a
  // user's own always-approve setting from skipping them. Grok runs reads and searches without asking.
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  // `GROK_SUBAGENTS=0`, Grok's documented switch, removes its subagent tool.
  nativeSubagents: "disableable",
  // Each prompt's answer carries its tokens and their cost (`_meta.usage`).
  usageReporting: "tokensAndCost",
  // `x.ai/compact_conversation`.
  compact: true,
  defaultConcurrency: 4,
};
