import type { CapabilityManifest } from "@cerium/protocol";

// `@opencode/client` drives the user's installed `opencode` over its v2 HTTP API. Every session gets a
// private `opencode serve --stdio` of its own, so its MCP servers and permissions stay its own; the
// server shares the user's OpenCode data (sign-ins, sessions, saved permissions) with their own runs,
// and Cerium's sessions show up in their OpenCode history.

export const LOGIN_COMMAND = "opencode auth login";
export const INSTALL_HINT =
  "Install OpenCode 2 from https://opencode.ai (`npm i -g @opencode/cli`), then run `opencode auth login`.";

export const opencodeManifest: CapabilityManifest = {
  provider: "opencode",
  // The v2 API the pinned `@opencode/client` 2.0.32 is generated from. Raise `testedMaximum` after
  // re-recording the fixture and re-running the live check.
  harnessVersion: { minimum: "2.0.32", testedMaximum: "2.0.32" },
  // A session id resumes on any server sharing the user's data; `session.fork` copies one up to a
  // message.
  session: { resume: true, fork: true },
  // `session.switchModel` takes the model and its variant (OpenCode's effort) together, from the next
  // step. Whether a variant switch keeps the provider's prompt cache depends on the provider.
  switching: { model: true, effort: true, cacheSafeEffort: false },
  input: { images: true },
  // Each session's permission rules decide what asks; asks arrive as `permission.asked` events and
  // are answered with `permission.reply`. `readOnly` denies everything but reading and the web.
  permissions: { approvals: "protocol", readOnlyMode: true },
  mcpInjection: true,
  // A `subagent` deny rule hides OpenCode's subagent tool.
  nativeSubagents: "disableable",
  // Every step ends with its tokens and its cost in USD (0 on free models).
  usageReporting: "tokensAndCost",
  defaultConcurrency: 4,
};
