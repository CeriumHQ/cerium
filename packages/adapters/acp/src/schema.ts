// The part of the Agent Client Protocol (https://agentclientprotocol.com) Cerium speaks, as TypeScript
// types. Written from the protocol's own generated schema (`@agentclientprotocol/sdk` 2.2.0,
// `dist/v1/schema/types.gen.d.ts`, protocol version 1), with the unstable members Cerium reads marked
// as such. Only what Cerium sends is relied on; everything an agent sends is read defensively (see
// `translate.ts`), since agents implement different slices of the protocol and add their own `_meta`.

export const PROTOCOL_VERSION = 1;

/** JSON-RPC error codes ACP gives meaning to. */
export const ErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** `$/cancel_request` cancelled the request. */
  requestCancelled: -32800,
  /** The agent needs `authenticate` before it can do this. */
  authRequired: -32000,
  /** The session or resource is not known. */
  resourceNotFound: -32002,
} as const;

export type Meta = { readonly [key: string]: unknown } | null | undefined;

export interface Implementation {
  readonly name: string;
  readonly title?: string | null;
  readonly version: string;
}

// ---------------------------------------------------------------------------------------------
// Initialization

export interface ClientCapabilities {
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
  readonly terminal?: boolean;
  readonly session?: {
    /** Cerium shows `compaction_update`s. */
    readonly compaction?: Record<string, unknown> | null;
    readonly configOptions?: { readonly boolean?: Record<string, unknown> | null } | null;
    readonly notices?: Record<string, unknown> | null;
  } | null;
  readonly auth?: { readonly terminal?: boolean };
  readonly _meta?: Meta;
}

export interface InitializeRequest {
  readonly protocolVersion: number;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation;
  readonly _meta?: Meta;
}

export interface AgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
  };
  readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
  readonly sessionCapabilities?: {
    readonly list?: object | null;
    readonly delete?: object | null;
    readonly additionalDirectories?: object | null;
    readonly resume?: object | null;
    readonly close?: object | null;
    /** Unstable: `session/fork`. */
    readonly fork?: object | null;
    /** Unstable: `systemPrompt` on session lifecycle requests. */
    readonly systemPrompt?: { readonly mode?: unknown } | null;
  };
  readonly auth?: { readonly logout?: object | null };
  readonly _meta?: Meta;
}

export interface AuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  /** `terminal`: the client runs the agent's own login in a terminal with `args` and `env`. */
  readonly type?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly _meta?: Meta;
}

export interface InitializeResponse {
  readonly protocolVersion: number;
  readonly agentCapabilities?: AgentCapabilities;
  readonly authMethods?: ReadonlyArray<AuthMethod>;
  readonly agentInfo?: Implementation | null;
  readonly _meta?: Meta;
}

// ---------------------------------------------------------------------------------------------
// Sessions

export interface EnvVariable {
  readonly name: string;
  readonly value: string;
}

export interface HttpHeader {
  readonly name: string;
  readonly value: string;
}

export type McpServer =
  | {
      readonly type: "http";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<HttpHeader>;
    }
  | {
      readonly type: "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<HttpHeader>;
    }
  | {
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<EnvVariable>;
    };

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface SessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<SessionMode>;
}

export interface SessionConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: Meta;
}

export interface SessionConfigSelectGroup {
  readonly group: string;
  readonly name: string;
  readonly options: ReadonlyArray<SessionConfigSelectOption>;
}

/**
 * One of a session's settings. `category` says what it is for: `model` (the model picker),
 * `thought_level` (reasoning effort), `mode`, `model_config`, or an agent's own.
 */
export type SessionConfigOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly _meta?: Meta;
} & (
  | {
      readonly type: "select";
      readonly currentValue: string;
      readonly options: ReadonlyArray<SessionConfigSelectOption> | ReadonlyArray<SessionConfigSelectGroup>;
    }
  | { readonly type: "boolean"; readonly currentValue: boolean }
);

/**
 * The model state agents reported before session config options replaced it, still sent by many
 * (`session/set_model` switches it).
 */
export interface LegacyModelState {
  readonly currentModelId: string;
  readonly availableModels: ReadonlyArray<{
    readonly modelId: string;
    readonly name: string;
    readonly description?: string | null;
    readonly _meta?: Meta;
  }>;
}

/** What `session/new`, `session/load`, `session/resume` and `session/fork` answer (sessionId on new and fork). */
export interface SessionSetup {
  readonly sessionId?: string;
  readonly modes?: SessionModeState | null;
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** Legacy (pre config options). */
  readonly models?: LegacyModelState | null;
  readonly _meta?: Meta;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string | null;
  /** ISO 8601. */
  readonly updatedAt?: string | null;
  readonly _meta?: Meta;
}

export interface ListSessionsResponse {
  readonly sessions: ReadonlyArray<SessionInfo>;
  readonly nextCursor?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Prompt turns

export type ContentBlock =
  | { readonly type: "text"; readonly text: string; readonly _meta?: Meta }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
      readonly uri?: string | null;
    }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name: string;
      readonly title?: string | null;
      readonly mimeType?: string | null;
    }
  | {
      readonly type: "resource";
      readonly resource:
        | { readonly uri: string; readonly text: string; readonly mimeType?: string | null }
        | { readonly uri: string; readonly blob: string; readonly mimeType?: string | null };
    };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** Unstable: what a turn spent, on `session/prompt`'s answer. */
export interface TurnUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thoughtTokens?: number | null;
  readonly cachedReadTokens?: number | null;
  readonly cachedWriteTokens?: number | null;
}

export interface PromptResponse {
  readonly stopReason: StopReason;
  readonly usage?: TurnUsage | null;
  readonly _meta?: Meta;
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { readonly type: "content"; readonly content: ContentBlock }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

export interface ToolCallLocation {
  readonly path: string;
  readonly line?: number | null;
}

/** A `tool_call`, or a `tool_call_update` with only what changed. */
export interface ToolCallFields {
  readonly toolCallId: string;
  readonly title?: string | null;
  /** The tool's own name, where the agent reports it (newer agents). */
  readonly name?: string | null;
  readonly kind?: ToolKind | null;
  readonly status?: ToolCallStatus | null;
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: Meta;
}

export interface PlanEntry {
  readonly content: string;
  readonly priority?: "high" | "medium" | "low";
  readonly status: "pending" | "in_progress" | "completed";
}

export interface AvailableCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string } | null;
}

export type SessionUpdate =
  | {
      readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
      readonly content: ContentBlock;
      readonly messageId?: string | null;
      readonly _meta?: Meta;
    }
  | ({ readonly sessionUpdate: "tool_call" | "tool_call_update" } & ToolCallFields)
  | { readonly sessionUpdate: "plan"; readonly entries: ReadonlyArray<PlanEntry> }
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: ReadonlyArray<AvailableCommand>;
    }
  | { readonly sessionUpdate: "current_mode_update"; readonly currentModeId: string }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: ReadonlyArray<SessionConfigOption>;
    }
  | {
      readonly sessionUpdate: "session_info_update";
      readonly title?: string | null;
      readonly updatedAt?: string | null;
    }
  | {
      readonly sessionUpdate: "usage_update";
      /** Tokens in the context now. */
      readonly used: number;
      /** The context window. */
      readonly size: number;
      /** The session's cost so far. */
      readonly cost?: { readonly amount: number; readonly currency: string } | null;
    }
  | {
      readonly sessionUpdate: "notice";
      readonly severity: string;
      readonly title: string;
      readonly description?: string | null;
    }
  | {
      readonly sessionUpdate: "compaction_update";
      readonly compactionId: string;
      readonly status: string;
      readonly summary?: ReadonlyArray<ContentBlock> | null;
      readonly error?: string | null;
    }
  | {
      readonly sessionUpdate: "compaction_summary_chunk";
      readonly compactionId: string;
      readonly content: ContentBlock;
    };

export interface SessionNotification {
  readonly sessionId: string;
  readonly update: SessionUpdate;
  readonly _meta?: Meta;
}

// ---------------------------------------------------------------------------------------------
// Permissions

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: ToolCallFields;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly _meta?: Meta;
}

export type RequestPermissionOutcome =
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "selected"; readonly optionId: string };

export interface RequestPermissionResponse {
  readonly outcome: RequestPermissionOutcome;
}
