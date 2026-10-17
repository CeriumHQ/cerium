import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "codex login";
export const INSTALL_HINT =
  "Install the Codex CLI from https://developers.openai.com/codex/cli, then run `codex login`.";

export const codexManifest: CapabilityManifest = {
  provider: "codex",
  // Raise `testedMaximum` after regenerating src/protocol, re-recording fixtures and re-running the
  // live smoke test against the newer version.
  harnessVersion: { minimum: "0.162.1", testedMaximum: "0.162.1" },
  // `thread/resume` reopens a thread by id. `thread/fork` exists but the adapter contract has no way
  // to ask for a fork yet.
  session: { resume: true, fork: false },
  // `turn/start` takes `model` and `effort` overrides that apply from that turn on.
  switching: { model: true, effort: true, cacheSafeEffort: false },
  // `turn/start` accepts image and local-image inputs, and the listed models take images.
  input: { images: true },
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  // Token counts per turn; the app-server reports no cost.
  usageReporting: "tokens",
  defaultConcurrency: 6,
};
