import type { SessionOptions } from "@cerium/harness";
import type { AccessMode, CapabilityManifest, ProviderId, ReasoningEffort } from "@cerium/protocol";

import type { Effect } from "effect";

import type { AcpConnection, AcpError } from "./connection.ts";
import type {
  AgentCapabilities,
  InitializeResponse,
  McpServer,
  PromptResponse,
  SessionMode,
} from "./schema.ts";
import type { DescribedTool, ToolCallState, TurnTotals } from "./translate.ts";

// What one ACP harness tells the shared client: how to run it, how its modes and tools line up with
// Cerium's, and what its manifest promises. Everything else (the handshake, sessions, prompts,
// approvals, history) is ACP's and lives in this package. A new ACP harness is a definition, a probe
// and a model list.

/** Why a process is started: a session's agent, or one of Cerium's own short jobs. */
export type LaunchPurpose = "session" | "probe" | "completion" | "sideQuestion" | "history";

/** What a harness's command line may depend on. */
export interface AcpLaunch {
  readonly purpose: LaunchPurpose;
  readonly cwd: string;
  readonly access: AccessMode;
  readonly model?: string | undefined;
  readonly effort?: ReasoningEffort | undefined;
  /** Cerium's instructions, for harnesses that take them on the command line (`instructions: "launch"`). */
  readonly appendSystemPrompt?: string | undefined;
  /** Load the MCP servers the user configured in the harness too. */
  readonly includeUserMcpServers: boolean;
  /** Names of the servers Cerium passes on `session/new`. */
  readonly injectedMcpServers: ReadonlyArray<string>;
}

export interface AcpCommand {
  readonly args: ReadonlyArray<string>;
  /** Added to the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** The agent's own extras on `initialize`. */
  readonly initializeMeta?: Readonly<Record<string, unknown>>;
  /** The agent's own extras on `session/new`, `session/resume` and `session/load`. */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * MCP servers of the user's own to pass beside Cerium's, for agents that leave loading the user's
   * configuration to their client (`includeUserMcpServers`).
   */
  readonly userMcpServers?: Effect.Effect<ReadonlyArray<McpServer>>;
}

/** The sign-in an agent wants before its first session: a method to `authenticate` with, or none. */
export type AcpSignIn =
  /** Already signed in, or signs in on its own: nothing to call. */
  | { readonly _tag: "Ready" }
  /** Call `authenticate` with this method (a stored credential, not an interactive login). */
  | {
      readonly _tag: "Authenticate";
      readonly methodId: string;
      readonly meta?: Readonly<Record<string, unknown>>;
    }
  /** Only an interactive login would do: the user has to sign in with the harness itself. */
  | { readonly _tag: "SignedOut" };

export interface AcpHarness {
  readonly provider: ProviderId;
  /** The harness as its makers name it: "Grok Build". */
  readonly name: string;
  /** The harness's own login command, run in Cerium's terminal. */
  readonly loginCommand?: string;
  /** The ACP agent's command line: `grok agent stdio`, `kimi acp`. */
  command(launch: AcpLaunch): AcpCommand;
  /**
   * The session mode that fits an access mode, among those the agent offers; none leaves the agent's
   * own. Cerium's answers to permission requests enforce the access mode either way (`autoAnswer`).
   */
  modeFor?(access: AccessMode, modes: ReadonlyArray<SessionMode>): string | undefined;
  /** How the harness's tools read in the transcript, where the generic description by kind misses. */
  describeTool?(call: ToolCallState, servers: ReadonlyArray<string>): DescribedTool | undefined;
  /**
   * Tools Cerium never lets run, whatever the access mode: native subagents (Cerium's bus spawns
   * agents) and question tools (agents ask through `ask_user`). Denied when the agent asks about them;
   * harnesses that can turn them off do so on the command line too.
   */
  isWithheld?(call: ToolCallState, described: DescribedTool): boolean;
  /**
   * How Cerium's instructions reach the agent: ACP's `systemPrompt` where the agent advertises it,
   * else the command line (`launch`), else before the session's first prompt (`firstPrompt`).
   */
  readonly instructions: "launch" | "firstPrompt";
  /** Whether `session/prompt`'s `usage` counts the turn or the session so far. */
  readonly usage?: "turn" | "session";
  /** A turn's tokens and cost where the agent reports them its own way (in `_meta`). */
  turnUsage?(response: PromptResponse): TurnTotals | undefined;
  /** How the agent wants to be signed in, from what `initialize` said. Absent: it needs nothing. */
  signIn?(initialized: InitializeResponse): AcpSignIn;
  /**
   * Compacts a session outside a prompt (an extension method). Without it, `compactCommand` is sent
   * as a prompt.
   */
  compact?(connection: AcpConnection, sessionId: string): Effect.Effect<void, AcpError>;
  /**
   * Copies a session up to, not including, its `promptIndex`th prompt (all of it when absent) and
   * resolves with the copy's id. Absent: ACP's own unstable `session/fork`, which copies it whole.
   */
  fork?(
    connection: AcpConnection,
    request: { readonly sessionId: string; readonly cwd: string; readonly promptIndex?: number },
  ): Effect.Effect<string, AcpError>;
  /** Deletes a session Cerium made for itself, where ACP's `session/delete` isn't offered. */
  deleteSession?(connection: AcpConnection, sessionId: string, cwd: string): Effect.Effect<void, AcpError>;
  /**
   * Answers a question about a session from the process that runs it, without the session hearing of
   * it (Grok's `/btw`). Without it, a side question runs on a deleted copy of the session.
   */
  sideQuestion?(
    connection: AcpConnection,
    sessionId: string,
    question: string,
  ): Effect.Effect<string, AcpError>;
  /** How long after a prompt's answer late updates may still arrive (default 0). */
  readonly settleMillis?: number;
  /** The slash command that compacts the conversation, when the agent lists it. */
  readonly compactCommand?: string;
  /**
   * What the manifest promises before any agent has answered `initialize`. `refineManifest` narrows it
   * by what the agent advertised once one has.
   */
  readonly manifest: CapabilityManifest;
  /**
   * The manifest as the installed agent's capabilities make it, from `initialize`. By default
   * (`refinedManifest`): resume needs `session/resume` or `session/load`, images need `image` prompts.
   */
  refineManifest?(manifest: CapabilityManifest, capabilities: AgentCapabilities): CapabilityManifest;
}

/** The manifest narrowed by what an agent advertised: claims the agent can't back are withdrawn. */
export const refinedManifest = (
  manifest: CapabilityManifest,
  capabilities: AgentCapabilities,
): CapabilityManifest => {
  const session = capabilities.sessionCapabilities ?? {};
  const resumes =
    capabilities.loadSession === true || (session.resume !== undefined && session.resume !== null);
  return {
    ...manifest,
    session: { ...manifest.session, resume: manifest.session.resume && resumes },
    input: { images: manifest.input.images && capabilities.promptCapabilities?.image === true },
  };
};

/** The session options for one of Cerium's own short jobs: read-only, no MCP servers, nothing of the user's. */
export const quietOptions = (
  base: Pick<SessionOptions, "cwd" | "model"> & Partial<SessionOptions>,
): SessionOptions => ({
  access: "readOnly",
  mcpServers: {},
  includeUserMcpServers: false,
  ...base,
});
