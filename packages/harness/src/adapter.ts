import type {
  CapabilityManifest,
  EventPayload,
  HarnessStatus,
  ProviderId,
  ReasoningEffort,
} from "@cerium/protocol";
import { Schema, type Effect, type Scope, type Stream } from "effect";

// The contract every provider adapter implements. Adapters translate; they never decide policy
// (spawn limits, approvals, persistence) — that belongs to the orchestrator.

/** Raised when a session can't start because of the user's machine state, with a fix they can act on. */
export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()("HarnessUnavailable", {
  provider: Schema.String,
  reason: Schema.Literals(["notInstalled", "versionTooOld", "loggedOut"]),
  message: Schema.String,
}) {}

/** An unexpected failure inside the harness or its SDK. */
export class HarnessFailure extends Schema.TaggedError<HarnessFailure>()("HarnessFailure", {
  provider: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A canonical payload plus the provider message it came from. Envelope fields are added downstream. */
export interface AdapterEvent {
  readonly payload: EventPayload;
  readonly raw?: unknown;
}

/**
 * What an agent may do without asking:
 * - `readOnly`: read/search/web tools only; writes are unavailable (chat mode, read-only children).
 * - `ask`: every write or command goes through Cerium's approval flow.
 * - `acceptEdits`: file edits in the workspace are auto-approved; commands still ask.
 */
export type AccessMode = "readOnly" | "ask" | "acceptEdits";

export type McpServerSpec =
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    };

export interface SessionOptions {
  readonly cwd: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly access: AccessMode;
  /** Servers Cerium injects, always including its orchestration bus. */
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  /** Also load the MCP servers the user configured in the harness itself. */
  readonly includeUserMcpServers: boolean;
  /** The harness's session id to resume. */
  readonly resume?: string;
  /** Instructions appended to the harness's own system prompt. */
  readonly appendSystemPrompt?: string;
}

export interface PermissionDecision {
  readonly decision: "allow" | "deny";
  readonly scope: "once" | "session";
  /** Shown to the agent when denying. */
  readonly message?: string;
}

/** A live harness session. Closing the scope it was started in ends the session. */
export interface AgentSession {
  readonly events: Stream.Stream<AdapterEvent, HarnessFailure>;
  send(text: string): Effect.Effect<void, HarnessFailure>;
  respondToPermission(requestId: string, decision: PermissionDecision): Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void, HarnessFailure>;
  setModel(model: string): Effect.Effect<void, HarnessFailure>;
  setEffort(effort: ReasoningEffort): Effect.Effect<void, HarnessFailure>;
}

export interface HarnessAdapter {
  readonly provider: ProviderId;
  readonly manifest: CapabilityManifest;
  readonly probe: Effect.Effect<HarnessStatus, HarnessFailure>;
  startSession(
    options: SessionOptions,
  ): Effect.Effect<AgentSession, HarnessUnavailable | HarnessFailure, Scope.Scope>;
}
