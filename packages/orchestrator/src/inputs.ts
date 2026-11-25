import type {
  AccessMode,
  AgentId,
  AssistantOrigin,
  Attachment,
  LimitPolicy,
  Mention,
  ModelSpeed,
  ProviderId,
  ReasoningEffort,
  ThreadId,
  ThreadMode,
  WorkspaceChoice,
} from "@cerium/protocol";

import type { TeardownFailure } from "./scripts.ts";
import type { CatalogEntry } from "./services.ts";

// What callers hand the orchestrator: the inputs and options of the `Orchestrator` service's
// operations, re-exported from orchestrator.ts.

export interface CreateThreadInput {
  readonly title: string;
  readonly mode: ThreadMode;
  /** Required for work threads: the folder the agents work in. */
  readonly cwd?: string;
  /** A work thread runs in a git worktree of `cwd`'s repository of its own instead of `cwd` itself. */
  readonly worktree?: boolean;
  readonly workspace?: WorkspaceChoice;
  /** Shared by the threads one message starts together (multi agent). */
  readonly runId?: string;
  /** What the thread does when its harness's limit runs out; absent follows the setting for all threads. */
  readonly onLimit?: LimitPolicy;
  readonly lead: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly effort?: ReasoningEffort;
    /** The lead starts on Auto: the effort router picks its effort while it is on. */
    readonly autoEffort?: boolean;
    readonly speed?: ModelSpeed;
    readonly access: AccessMode;
  };
}

export interface ForkThreadInput {
  readonly threadId: ThreadId;
  readonly turn: string;
  readonly workspace?: "current" | "worktree";
  readonly harness?: ProviderId;
  readonly model?: string;
}

/** Moves an existing chat thread into a project as a work thread, optionally kicking off implementation. */
export interface MoveChatToWorkInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktree?: boolean;
  readonly workspace?: WorkspaceChoice;
  readonly lead: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly effort?: ReasoningEffort;
    readonly autoEffort?: boolean;
    readonly speed?: ModelSpeed;
    readonly access: AccessMode;
  };
  /** When present, immediately starts implementing this message/instruction in the moved work thread. */
  readonly implement?: {
    readonly message?: string;
    readonly note?: string;
  };
}

/** What the user sent beside the text of a message. */
export interface UserMessageExtras {
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly mentions?: ReadonlyArray<Mention>;
  /** The assistant outside Cerium the user had send it. */
  readonly sentVia?: AssistantOrigin;
}

/** What a lead asks for through `spawn_agent`. */
export interface SpawnRequest {
  readonly role: string;
  /** A catalog alias, or a model id (with `provider` when it is not in the catalog). */
  readonly model: string;
  readonly provider?: ProviderId;
  readonly effort?: ReasoningEffort;
  readonly access?: AccessMode;
  readonly prompt: string;
  /** Workers load user MCP connections only when the assignment needs them. */
  readonly includeUserMcpServers?: boolean;
}

/**
 * What an assistant outside Cerium asks for on the user's behalf (assistants.ts in @cerium/protocol):
 * a work thread in `cwd`, or a chat without one.
 */
export interface AssistantThreadRequest {
  readonly assistant: string;
  /** The new lead's first message, which it takes as the user's request. */
  readonly prompt: string;
  /** A project folder; a chat without one. */
  readonly cwd?: string;
  /** Named from the prompt without one, like a thread the user starts. */
  readonly title?: string;
  /** A catalog alias or model id; the first model of the roster without one. */
  readonly model?: string;
  /** Whether it runs in a worktree of its own; only a work thread can. */
  readonly worktree?: boolean;
  readonly access: AccessMode;
}

/** The model an assistant's thread starts on without naming one: the roster's first, its harness's favourite. */
export const defaultAssistantModel = (entries: ReadonlyArray<CatalogEntry>): CatalogEntry | undefined =>
  entries.find((entry) => entry.priority === 1) ?? entries[0];

/** What a lead asks for through `create_thread`: a thread of the user's in its own folder. */
export interface ThreadRequest {
  /** The new lead's first message, which it takes as the user's request. */
  readonly prompt: string;
  /** Named from the prompt without one, like a thread the user starts. */
  readonly title?: string;
  /** A catalog alias or model id; the caller's own model without one. */
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** Never more than the caller's own. */
  readonly access?: AccessMode;
  /** A project folder; lets a chat lead start a work thread in a saved project when asked. */
  readonly folder?: string;
  /** Whether it runs in a worktree of its own; as the caller's thread does without it. */
  readonly worktree?: boolean;
  readonly workspace?: WorkspaceChoice;
}

export type SpawnOutcome =
  | { readonly _tag: "Spawned"; readonly agentId: AgentId }
  | { readonly _tag: "PendingApproval"; readonly requestId: string };

export interface SpawnApproval {
  readonly decision: "allow" | "deny";
  /** The user may approve with a different model than the lead asked for. */
  readonly replacement?: { readonly provider: ProviderId; readonly model: string };
}

/**
 * A model of the agent's harness, its effort and its speed (none for a model without that setting, or
 * the harness's default speed).
 */
export interface ModelChoice {
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly speed?: ModelSpeed;
  /**
   * Auto: the effort router picks the effort while it is on. Absent from a switch, the agent stays as
   * it is unless an effort is picked, which takes it off.
   */
  readonly autoEffort?: boolean;
}

/** A model of another harness a lead is handed to (`handOffLead`). */
export interface HandoffTarget extends ModelChoice {
  readonly provider: ProviderId;
}

/** How archiving or deleting a thread treats the work in its worktree. */
export interface PutAwayOptions {
  /**
   * The user saw what the worktree holds that its base doesn't and still wants it gone. Without it, a
   * worktree with uncommitted changes or unmerged commits keeps its thread from being put away.
   */
  readonly discardWork?: boolean;
  /**
   * Told when the project's teardown, run in the worktree before it goes, didn't end well. It never
   * keeps the thread from being put away.
   */
  readonly onTeardownFailed?: (failure: TeardownFailure) => void;
}
