import type {
  AccessMode,
  CapabilityManifest,
  EventPayload,
  HarnessStatus,
  LoginProgress,
  ModelInfo,
  ModelSpeed,
  ProviderId,
  ReasoningEffort,
  SkillInfo,
  UsageMeter,
} from "@cerium/protocol";
import { Schema, type Effect, type Option, type Scope, type Stream } from "effect";

import type { HarnessHub } from "./hub.ts";

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
  /** Absent: the harness's own default, as the user configured it. */
  readonly speed?: ModelSpeed;
  readonly access: AccessMode;
  /** Servers Cerium injects, always including its orchestration bus. */
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  /** Also load the MCP servers the user configured in the harness itself. */
  readonly includeUserMcpServers: boolean;
  /** Injected servers whose tools run without approval prompts (Cerium's own bus). */
  readonly trustedMcpServers?: ReadonlyArray<string>;
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

/** An image a turn shows the model, read from disk by Cerium. */
export interface TurnImage {
  readonly path: string;
  readonly mediaType: string;
  /** The file's bytes, base64-encoded. */
  readonly data: string;
}

/** What a turn carries beside its text. */
export interface TurnExtras {
  /** Only sent to harnesses whose manifest takes images. */
  readonly images?: ReadonlyArray<TurnImage>;
  /** Skills the user picked; the text names each as `$name`. */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly path?: string }>;
  /**
   * A UUID Cerium gave the turn, which `fork` names it by later. Adapters whose harness takes an id
   * for the user's message give it this one.
   */
  readonly turnId?: string;
}

/** One of the turns Cerium sent a session. */
export interface TurnRef {
  /** The `turnId` it was sent with; absent for turns sent before Cerium gave them ids. */
  readonly id?: string;
  /** How many turns the session had before it, counted from its first. */
  readonly index: number;
}

/** A copy of a session that ends before one of its turns. */
export interface ForkRequest {
  readonly cwd: string;
  /** The harness's session id to copy from; it stays as it was. */
  readonly sessionId: string;
  /** The first turn the copy leaves out, with every turn after it. Never the session's first turn. */
  readonly before: TurnRef;
}

/** A one-off question Cerium asks for its own small jobs, such as naming a thread. */
export interface CompletionRequest {
  readonly model: string;
  /** The whole system prompt where the harness lets it be replaced; otherwise it opens the prompt. */
  readonly instructions: string;
  readonly prompt: string;
  /** An empty folder to run in, so no project's instructions or skills load. */
  readonly cwd: string;
}

/** A question put to a throwaway copy of a session's conversation, which answers and is forgotten. */
export interface SideQuestionRequest {
  readonly model: string;
  readonly cwd: string;
  /** The harness's session id whose conversation the question is asked in; it stays as it was. */
  readonly sessionId: string;
  /** Opens the copy's instructions: it answers rather than carries on, and changes nothing. */
  readonly instructions: string;
  readonly prompt: string;
}

/** A subscription's plan and meters, as an adapter reads them. */
export interface SubscriptionReport {
  readonly plan?: string;
  readonly meters: ReadonlyArray<UsageMeter>;
  readonly resetCredits?: number;
}

/** A session the user had with the harness outside Cerium, as the harness lists it. */
export interface PastSession {
  /** The harness's own session id, which `SessionOptions.resume` continues. */
  readonly id: string;
  /** The folder it ran in, when the harness recorded one. */
  readonly cwd?: string;
  /** Its title, or its first message when it has none. */
  readonly title: string;
  readonly createdAt?: number;
  /** Its last activity. */
  readonly updatedAt: number;
  /** How many turns it holds, when the harness counts them. */
  readonly turns?: number;
  /** How much the harness keeps of it on disk, when it says. */
  readonly bytes?: number;
  /** The model it last ran on, when the harness says. */
  readonly model?: string;
}

/** One turn of a past session: what the user sent, and the reply as canonical events. */
export interface PastTurn {
  readonly prompt: string;
  /** When it was sent, when the harness recorded it. */
  readonly at?: number;
  readonly events: ReadonlyArray<AdapterEvent>;
}

/** A past session's conversation, oldest turn first. */
export interface PastHistory {
  /** The model it last ran on, when the history says. */
  readonly model?: string;
  readonly turns: ReadonlyArray<PastTurn>;
}

/** A live harness session. Closing the scope it was started in ends the session. */
export interface AgentSession {
  readonly events: Stream.Stream<AdapterEvent, HarnessFailure>;
  send(text: string, extras?: TurnExtras): Effect.Effect<void, HarnessFailure>;
  respondToPermission(requestId: string, decision: PermissionDecision): Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void, HarnessFailure>;
  setModel(model: string): Effect.Effect<void, HarnessFailure>;
  setEffort(effort: ReasoningEffort): Effect.Effect<void, HarnessFailure>;
  /** From the next turn. Present when the manifest's `switching.speed` is. */
  setSpeed?(speed: ModelSpeed): Effect.Effect<void, HarnessFailure>;
  /**
   * Asks the harness to compact the conversation now, between turns. It runs as a turn of its own,
   * which reports `ContextCompacted` and ends with `TurnCompleted` like one `send` starts. Present when
   * the manifest's `compact` is.
   */
  readonly compact?: Effect.Effect<void, HarnessFailure>;
}

export interface HarnessAdapter {
  readonly provider: ProviderId;
  readonly manifest: CapabilityManifest;
  readonly probe: Effect.Effect<HarnessStatus, HarnessFailure>;
  /** The models the user's installed, logged-in harness offers right now. */
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, HarnessUnavailable | HarnessFailure>;
  /**
   * The SDK's own browser sign-in, for harnesses whose status offers `browserLogin`. It ends after
   * `SignedIn`; interrupting it cancels the sign-in. The SDK stores the credential it gets.
   */
  readonly login?: Stream.Stream<LoginProgress, HarnessFailure>;
  /**
   * The skills the harness would offer a session in `cwd`, for the message box's `$` list. Absent
   * when the harness can't say without starting a session.
   */
  listSkills?(cwd: string): Effect.Effect<ReadonlyArray<SkillInfo>, HarnessUnavailable | HarnessFailure>;
  /**
   * The subscription's usage meters, as the harness reports them right now. `None` when the harness
   * is signed in without a subscription; absent when the harness can't report its limits.
   */
  readonly usage?: Effect.Effect<Option.Option<SubscriptionReport>, HarnessUnavailable | HarnessFailure>;
  /**
   * Answers a `CompletionRequest` as quickly as the harness can: the model's lowest effort, no tools,
   * no MCP servers, none of the user's configuration, and nothing saved. Resolves with the reply's text.
   */
  complete(request: CompletionRequest): Effect.Effect<string, HarnessUnavailable | HarnessFailure>;
  /**
   * Copies a session's history up to a turn into a new session of the harness's own, which
   * `SessionOptions.resume` then continues, and resolves with its id. Present when the manifest's
   * `session.fork` is.
   */
  fork?(request: ForkRequest): Effect.Effect<string, HarnessUnavailable | HarnessFailure>;
  /**
   * Answers a question in a copy of a session's conversation, even while the session is mid-turn: the
   * copy sees what the session did so far, can only read, saves nothing and is gone with the answer, and
   * the session never learns of it. Resolves with the reply's text. Present when the harness can copy
   * a session without leaving the copy in its history.
   */
  sideQuestion?(request: SideQuestionRequest): Effect.Effect<string, HarnessUnavailable | HarnessFailure>;
  /**
   * The user's own sessions with the harness, newest first, for bringing them into Cerium. It reads
   * sessions only, never credentials, and leaves out the ones Cerium's adapters start where the
   * harness can tell. Absent when the harness offers no listing.
   */
  readonly listSessions?: Effect.Effect<ReadonlyArray<PastSession>, HarnessUnavailable | HarnessFailure>;
  /**
   * A listed session's conversation, translated like a live session's events. Absent when the harness
   * can resume a session but not give its history.
   */
  readSession?(session: PastSession): Effect.Effect<PastHistory, HarnessUnavailable | HarnessFailure>;
  /** The harness's own MCP servers and skills, for the hub. Absent when Cerium can't read them. */
  readonly hub?: HarnessHub;
  startSession(
    options: SessionOptions,
  ): Effect.Effect<AgentSession, HarnessUnavailable | HarnessFailure, Scope.Scope>;
}
