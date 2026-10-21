import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "muse login";
export const INSTALL_HINT =
  "Install Muse Code from https://dev.meta.ai/docs/muse-code, then run `muse login`.";

/**
 * The Muse Code release the pinned `@muse-code/sdk` ships with: the SDK versions in lockstep with the
 * CLI, and its `EXPECTED_SCHEMA_FINGERPRINT` is this release's stable MSP schema.
 */
export const SDK_RELEASE = "1.4.8";

export const museManifest: CapabilityManifest = {
  provider: "muse",
  // The SDK versions in lockstep with the CLI, which updates itself when it starts.
  releases: { npmPackage: "@muse-code/sdk" },
  // `session/resume` takes the id `SessionStarted` reports. MSP's `session/fork` is not wired: sessions
  // have no fork option yet.
  session: { resume: true, fork: false },
  // `session/setModel` and `session/setReasoningEffort` apply mid-session. Whether an effort switch keeps
  // Meta's prompt cache has no live evidence yet, so it is not claimed.
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  // `:read-only` profile plus `--disable-write --disable-shell` on the host; approvals are MSP
  // `approval/requested` notifications answered with `approval/decide`.
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  // `run.subagent_delegation_mode="off"` hides the native subagent tools, `run.workflow_trigger_mode="off"`
  // removes the `workflow` tool, and `agents.execution_capacity=1` leaves the root no child slot.
  nativeSubagents: "disableable",
  // `session/tokenUsage` per model call. Its cost member is a server estimate that only appears for priced
  // routes, so cost is passed through when present but not promised.
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
