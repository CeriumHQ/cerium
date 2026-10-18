import {
  AccessMode,
  AgentEvent,
  AgentId,
  AgentInfo,
  Attachment,
  HarnessStatus,
  ImageData,
  LoginProgress,
  Mention,
  ModelInfo,
  ProjectInfo,
  ProviderId,
  ReasoningEffort,
  Settings,
  SettingsPatch,
  SkillInfo,
  ThreadId,
  ThreadInfo,
  ThreadMode,
  WorkspaceEntry,
} from "@cerium/protocol";
import { Schema, Struct } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// The contract between the UI and the backend, served over a localhost WebSocket
// (docs/architecture.md §7). Payloads and results are protocol schemas, so both sides validate them.

/** A request the backend refused; `message` is written for the user. */
export class CeriumError extends Schema.TaggedError<CeriumError>()("CeriumError", {
  message: Schema.String,
}) {}

/**
 * An event as the UI receives it. The provider's original message stays in the store: the UI never
 * reads it, and it isn't always strict JSON (SDKs leave `undefined` fields in), which would fail the
 * whole response. Encoding drops keys a struct doesn't declare.
 */
export const UiEvent = AgentEvent.mapFields(Struct.omit(["raw"]));
export type UiEvent = typeof UiEvent.Type;

/** What the sidebar needs about one thread. */
export const ThreadOverview = Schema.Struct({
  thread: ThreadInfo,
  agents: Schema.Array(AgentInfo),
  awaitingApproval: Schema.Boolean,
});
export type ThreadOverview = typeof ThreadOverview.Type;

export const CreateThreadPayload = Schema.Struct({
  title: Schema.String,
  mode: ThreadMode,
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  lead: Schema.Struct({
    provider: ProviderId,
    model: Schema.NonEmptyString,
    effort: Schema.optionalKey(ReasoningEffort),
    access: AccessMode,
  }),
});
export type CreateThreadPayload = typeof CreateThreadPayload.Type;

export const CeriumRpcs = RpcGroup.make(
  Rpc.make("ListThreads", { success: Schema.Array(ThreadOverview), error: CeriumError }),
  Rpc.make("ThreadEvents", {
    payload: { threadId: ThreadId },
    success: Schema.Array(UiEvent),
    error: CeriumError,
  }),
  /** Every agent's events as they happen, streaming deltas included. */
  Rpc.make("WatchEvents", { success: UiEvent, stream: true }),
  Rpc.make("CreateThread", {
    payload: CreateThreadPayload,
    success: Schema.Struct({ thread: ThreadInfo, lead: AgentInfo }),
    error: CeriumError,
  }),
  /** A message needs text, attachments or both. */
  Rpc.make("SendMessage", {
    payload: {
      agentId: AgentId,
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(Attachment)),
      mentions: Schema.optionalKey(Schema.Array(Mention)),
    },
    error: CeriumError,
  }),
  Rpc.make("RespondToPermission", {
    payload: {
      agentId: AgentId,
      requestId: Schema.NonEmptyString,
      decision: Schema.Literals(["allow", "deny"]),
      scope: Schema.Literals(["once", "session"]),
    },
    error: CeriumError,
  }),
  Rpc.make("ResolveSpawnApproval", {
    payload: {
      requestId: Schema.NonEmptyString,
      decision: Schema.Literals(["allow", "deny"]),
      replacement: Schema.optionalKey(Schema.Struct({ provider: ProviderId, model: Schema.NonEmptyString })),
    },
    error: CeriumError,
  }),
  Rpc.make("InterruptAgent", {
    payload: { agentId: AgentId, includeChildren: Schema.optionalKey(Schema.Boolean) },
    error: CeriumError,
  }),
  Rpc.make("StopAgent", { payload: { agentId: AgentId }, error: CeriumError }),
  /** The title is trimmed and must be 1 to 80 characters. */
  Rpc.make("RenameThread", {
    payload: { threadId: ThreadId, title: Schema.String },
    success: ThreadInfo,
    error: CeriumError,
  }),
  /** Archiving hides a thread until it is restored; refused while its agents work or wait on the user. */
  Rpc.make("SetThreadArchived", {
    payload: { threadId: ThreadId, archived: Schema.Boolean },
    success: ThreadInfo,
    error: CeriumError,
  }),
  Rpc.make("HarnessStatuses", { success: Schema.Array(HarnessStatus) }),
  /**
   * Runs a harness's own browser sign-in (status `browserLogin`). Unsubscribing cancels it; the
   * harness's SDK keeps the credential and Cerium never sees it.
   */
  Rpc.make("LoginHarness", {
    payload: { provider: ProviderId },
    success: LoginProgress,
    stream: true,
    error: CeriumError,
  }),
  /** The models one provider's harness offers; refused while that harness isn't usable. */
  Rpc.make("ListModels", {
    payload: { provider: ProviderId },
    success: Schema.Array(ModelInfo),
    error: CeriumError,
  }),
  /** Files and folders in `cwd` matching `query`, for the message box's `@` list. */
  Rpc.make("SearchWorkspace", {
    payload: { cwd: Schema.NonEmptyString, query: Schema.String },
    success: Schema.Array(WorkspaceEntry),
    error: CeriumError,
  }),
  /** The skills a provider's harness offers in `cwd` (its home folder without one), for `$`. */
  Rpc.make("ListSkills", {
    payload: { provider: ProviderId, cwd: Schema.optionalKey(Schema.NonEmptyString) },
    success: Schema.Array(SkillInfo),
    error: CeriumError,
  }),
  /** Keeps a pasted file that has no path of its own; `data` is base64. */
  Rpc.make("SaveAttachment", {
    payload: { name: Schema.String, mediaType: Schema.String, data: Schema.String },
    success: Attachment,
    error: CeriumError,
  }),
  /** An image file's bytes, for showing attachments and images agents read. */
  Rpc.make("ReadImage", {
    payload: { path: Schema.NonEmptyString },
    success: ImageData,
    error: CeriumError,
  }),
  /** The folders the composer offers to work in, most recently used first. */
  Rpc.make("ListProjects", { success: Schema.Array(ProjectInfo), error: CeriumError }),
  /** Saves a folder as a project, or marks a saved one as just used. */
  Rpc.make("SaveProject", {
    payload: { path: Schema.NonEmptyString },
    success: ProjectInfo,
    error: CeriumError,
  }),
  /** Forgets a project; threads that ran in it keep their folder. */
  Rpc.make("RemoveProject", { payload: { path: Schema.NonEmptyString }, error: CeriumError }),
  /** The branch checked out in a work thread's folder, or the short commit when detached; none outside git. */
  Rpc.make("GitBranch", {
    payload: { cwd: Schema.NonEmptyString },
    success: Schema.Struct({ branch: Schema.optionalKey(Schema.NonEmptyString) }),
  }),
  /** A project's own icon (its favicon, icon or logo), when it has one where projects keep them. */
  Rpc.make("ProjectIcon", {
    payload: { cwd: Schema.NonEmptyString },
    success: Schema.Struct({ icon: Schema.optionalKey(ImageData) }),
  }),
  Rpc.make("Settings", { success: Settings }),
  /** Changes the given settings; resolves with all of them. */
  Rpc.make("UpdateSettings", { payload: SettingsPatch, success: Settings, error: CeriumError }),
);
