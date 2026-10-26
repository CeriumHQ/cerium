import type { CapabilityManifest } from "@cerium/protocol";

export const LOGIN_COMMAND = "claude auth login";
export const INSTALL_HINT =
  "Install Claude Code from https://claude.com/claude-code, then run `claude auth login`.";

/** Built-in tools that spawn native subagents; Cerium's bus is the only way to spawn. */
export const NATIVE_SUBAGENT_TOOLS = ["Agent", "Workflow", "SendMessage"] as const;

/** Claude Code's own question tool; agents ask the user through the bus's `ask_user` instead. */
export const NATIVE_QUESTION_TOOLS = ["AskUserQuestion"] as const;

/**
 * Claude Code's todo tools: the Task tools, or `TodoWrite` where the user's environment turns tasks
 * off (`CLAUDE_CODE_ENABLE_TASKS=0`). A session on a model newer than Claude Code's own list has none
 * unless asked: `TODO_TOOLS_ENV` asks, as the Agent SDK's todo-tracking guide describes.
 */
export const TODO_TOOLS = ["TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"] as const;
export const TODO_TOOLS_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } as const;

export const claudeManifest: CapabilityManifest = {
  provider: "claude",
  releases: { npmPackage: "@anthropic-ai/claude-code", updateCommand: "claude update" },
  session: { resume: true, fork: true },
  // Effort switches mid-session through `applyFlagSettings({ effortLevel })`. The prompt cache survives
  // the switch on the 5.5 and Fable 5.1 models only (`CACHE_SAFE_EFFORT` in models.ts).
  switching: { model: true, effort: true, cacheSafeEffort: true, speed: true },
  input: { images: true },
  permissions: { approvals: "callback", readOnlyMode: true },
  mcpInjection: true,
  nativeSubagents: "disableable",
  usageReporting: "tokensAndCost",
  // `/compact` as a message of its own.
  compact: true,
  defaultConcurrency: 6,
};
