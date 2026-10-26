import type { CapabilityManifest } from "@cerium/protocol";

// `@cursor/sdk` runs Cursor's agent runtime inside this process ("local mode") with its own bundled
// tools; sessions never call the user's `cursor-agent` CLI and do not share its login. Only the plan's
// limits come from that CLI, which shows them with its own login (usage.ts). The SDK itself
// resolves credentials: `CURSOR_API_KEY` from the environment, else the key its own browser login
// (`Cursor.auth.login()`, started from Settings → Harnesses) minted into `~/.cursor/sdk/auth.json`.
// Cerium passes no `apiKey`.

/**
 * Built-in tools that start or drive native agents; Cerium's bus is the only way to spawn. `task` is
 * the subagent tool; the others manage agents `createAgent` started. All are names the SDK accepts
 * (it rejects unknown ones at `Agent.create`).
 */
export const NATIVE_SUBAGENT_TOOLS = [
  "task",
  "createAgent",
  "sendToAgent",
  "getAgentStatus",
  "stopAgent",
  "readAgentTranscript",
] as const;

/**
 * Cursor's own question tool. A local run rejects every call to it ("Interactive questions are not
 * supported in local SDK runs"), so it is withheld and agents ask through the bus's `ask_user`.
 */
export const NATIVE_QUESTION_TOOLS = ["askQuestion"] as const;

export const cursorManifest: CapabilityManifest = {
  provider: "cursor",
  // The harness is the pinned `@cursor/sdk`, not the user's CLI, so it updates with Cerium.
  // Local agents resume from the SDK's own store; the SDK has no fork.
  session: { resume: true, fork: false },
  // Model and effort ride on each `send()`, so they switch from the next turn. Whether an effort
  // change keeps the prompt cache has not been measured.
  switching: { model: true, effort: true, cacheSafeEffort: false, speed: true },
  input: { images: true },
  // The SDK cannot ask: local runs execute every tool call, and hooks load only from files in the
  // user's repo or home. Until a hook bridge is possible the session withholds every tool that would
  // need approval (session.ts).
  permissions: { approvals: "none", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  // Turn-end usage carries tokens; cost only arrives later and eventually consistent via `getUsage()`.
  usageReporting: "tokens",
  defaultConcurrency: 4,
};
