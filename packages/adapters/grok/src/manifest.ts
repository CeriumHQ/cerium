import type { CapabilityManifest } from "@cerium/protocol";

// Grok Build (xAI's `grok` CLI) runs as an ACP agent with `grok agent stdio`; every Cerium session gets
// a process of its own. What it does over ACP is read from xAI's docs (docs.x.ai/build) and the
// published Grok Build source (github.com/xai-org/grok-build, snapshot 2026-09-29), not yet from a
// signed-in run: see the package's scripts for the live checks.

export const LOGIN_COMMAND = "grok login";
export const INSTALL_HINT =
  "Install Grok Build from https://docs.x.ai/build (`curl -fsSL https://x.ai/cli/install.sh | bash`), then run `grok login`. It needs a SuperGrok or X Premium+ plan, or an xAI API key.";

export const grokManifest: CapabilityManifest = {
  provider: "grok",
  releases: { npmPackage: "@xai-official/grok", updateCommand: "grok update" },
  // `session/resume` (and `session/load`) continue a session by id; `_x.ai/session/fork` copies one up
  // to a prompt index (`targetPromptIndex`), which is Cerium's fork.
  session: { resume: true, fork: true },
  // The `model` and `reasoning_effort` (thought_level) config options switch mid-session. Whether an
  // effort switch keeps xAI's prompt cache has not been measured.
  switching: { model: true, effort: true, cacheSafeEffort: false },
  // Grok 1.0.70 advertises `image` prompts (seen live); a version that stops is narrowed to none.
  input: { images: true },
  // Tool approvals come as `session/request_permission`; `yoloMode: false` on `session/new` keeps the
  // user's own always-approve setting from skipping them. Read-only runs in Grok's `read-only` sandbox
  // profile, and Cerium denies anything that would write.
  permissions: { approvals: "protocol", readOnlyMode: true },
  // `session/new` takes MCP servers, HTTP ones included (`mcpCapabilities.http`).
  mcpInjection: true,
  // `GROK_SUBAGENTS=0` turns Grok's subagents off; Cerium also denies a `task` call should one ask.
  nativeSubagents: "disableable",
  // Each prompt's answer carries the turn's tokens and, when complete, its cost (`_meta.usage`).
  usageReporting: "tokensAndCost",
  // `_x.ai/compact_conversation` compacts between turns.
  compact: true,
  defaultConcurrency: 4,
};
