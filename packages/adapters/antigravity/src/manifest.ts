import type { CapabilityManifest } from "@cerium/protocol";

// Antigravity CLI (`agy`, Google's closed-source successor to Gemini CLI) has no ACP, server or SDK
// mode that works with an Antigravity sign-in, so Cerium drives its documented headless mode: each turn
// is an `agy --input-format stream-json --output-format stream-json` run, resumed by `--conversation`.
// Cerium's MCP servers, instructions and approval hook reach it through a custom agent and plugin of
// Cerium's own, written for the session and selected with `--agent` (launch.ts). Sources: Google's docs
// (antigravity.google/docs/cli), the 1.4.12 binary's own help, changelog and validator, run signed out.

/** Antigravity has no login command: running `agy` signs in. */
export const LOGIN_COMMAND = "agy";
export const INSTALL_HINT =
  "Install Antigravity CLI from https://antigravity.google/docs/cli (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), then run `agy` once to sign in.";

/**
 * Google's FAQ: wrapping `agy` in third-party apps "is not supported under consumer plans" and can get an
 * account suspended; it recommends a Gemini API key or Google Cloud. Told once per backend run.
 */
export const CONSUMER_PLAN_NOTICE =
  "Google's terms for Antigravity say running `agy` from other apps isn't supported on consumer (personal Google account) plans. To stay within them, sign Antigravity in with a Gemini API key (`modelProvider: \"gemini\"` and GEMINI_API_KEY) or Google Cloud (AGY_ADC_AUTH).";

export const antigravityManifest: CapabilityManifest = {
  provider: "antigravity",
  // The CLI updates itself; Cerium turns that off for its own runs (AGY_CLI_DISABLE_AUTO_UPDATE).
  // `--conversation <id>` resumes. The CLI forks only in its interactive `/fork`, so no fork.
  session: { resume: true, fork: false },
  // `--model` and `--effort` are flags of each turn's run, so both switch from the next turn.
  switching: { model: true, effort: true, cacheSafeEffort: false },
  // Streamed input takes text only ("non-text blocks cause an error").
  input: { images: false },
  // A `PreToolUse` hook (Cerium's own plugin) asks Cerium about every tool call and blocks until it
  // answers; read-only denies everything that writes. Headless runs would otherwise soft-deny.
  permissions: { approvals: "hookBridge", readOnlyMode: true },
  // Cerium's servers go in its plugin's `mcp_config.json`.
  mcpInjection: true,
  // The hook denies the subagent tools (`invoke_subagent`, `define_subagent`, `manage_subagents`,
  // `browser_subagent`) and `ask_question`, whatever the access mode.
  nativeSubagents: "disableable",
  // Each run's `result` carries its tokens; no cost.
  usageReporting: "tokens",
  compact: false,
  defaultConcurrency: 4,
};
