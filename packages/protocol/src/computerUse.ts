import { Schema } from "effect";

import { AgentId, EpochMillis, ThreadId } from "./ids.ts";

/**
 * Computer use: agents of any harness see and operate the user's desktop apps through the bus's
 * `computer_*` tools, which drive agent-desktop (`@cerium/computer`). Off until the user turns it
 * on; real mouse and keyboard input is a second choice on top.
 */
export const ComputerUseSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /**
   * Agents may also move the pointer, press keys and bring windows forward. Off, they act only
   * through apps' accessibility actions, which leave the user's pointer and focus alone.
   */
  physicalInput: Schema.Boolean,
});
export type ComputerUseSettings = typeof ComputerUseSettings.Type;

export const defaultComputerUse: ComputerUseSettings = { enabled: false, physicalInput: false };

/** Where agent-desktop, the program that does the work, stands on this computer. */
export const ComputerToolState = Schema.Literals(["missing", "installing", "ready", "failed", "unsupported"]);
export type ComputerToolState = typeof ComputerToolState.Type;

/** An agent using the computer: from its first call until it has been quiet for a while, or is stopped. */
export const ComputerUseSession = Schema.Struct({
  threadId: ThreadId,
  agentId: AgentId,
  /** The name the agent's cursor carries on screen, such as "opus · lead". */
  label: Schema.String,
  startedAt: EpochMillis,
  lastAt: EpochMillis,
  /** A call is running now. */
  busy: Schema.Boolean,
});
export type ComputerUseSession = typeof ComputerUseSession.Type;

export const ComputerUseStatus = Schema.Struct({
  tool: Schema.Struct({
    state: ComputerToolState,
    /** The agent-desktop version this build runs. */
    version: Schema.String,
    /** Why it failed, or what an unsupported computer lacks. */
    message: Schema.optionalKey(Schema.String),
  }),
  /**
   * The operating system's own permission for reading and operating other apps (macOS
   * Accessibility); absent until the tool is ready, and on systems that need no grant.
   */
  permission: Schema.optionalKey(Schema.Literals(["granted", "needed"])),
  sessions: Schema.Array(ComputerUseSession),
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;
