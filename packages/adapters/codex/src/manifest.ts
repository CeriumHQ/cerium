import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "codex login";
export const INSTALL_HINT =
  "Install the Codex CLI from https://developers.openai.com/codex/cli, then run `codex login`.";

export const codexManifest: CapabilityManifest = {
  provider: "codex",
  releases: { npmPackage: "@openai/codex", updateCommand: "codex update" },
  // `thread/resume` reopens a thread by id; `thread/fork` copies one through a turn.
  session: { resume: true, fork: true },
  // `turn/start` takes `model` and `effort` overrides that apply from that turn on. An effort switch
  // keeps the prompt cache on the models OpenAI's catalog marks for it (`cacheSafeFromCatalog` in
  // models.ts, and `reasoning_effort_override` in `threadConfig`).
  switching: { model: true, effort: true, cacheSafeEffort: true },
  // `turn/start` accepts image and local-image inputs, and the listed models take images.
  input: { images: true },
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  // Token counts per turn; the app-server reports no cost.
  usageReporting: "tokens",
  // `thread/compact/start`, which runs a turn of its own.
  compact: true,
  defaultConcurrency: 6,
};
