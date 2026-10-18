import {
  AccessMode,
  AccountState,
  AccountThreads,
  AgentId,
  AgentInfo,
  Attachment,
  DeviceId,
  DeviceName,
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
  ThreadOverview,
  UiEvent,
  WorkspaceEntry,
  ReadEntry,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// The contract between the UI and the backend, served over a localhost WebSocket
// (docs/architecture.md §7). Payloads and results are protocol schemas, so both sides validate them.

/**
 * The version of this contract. Changes only add (docs/architecture.md §14.1): a new RPC, or an
 * optional field. Bump it with each addition a client relies on, so a client driving another
 * machine knows what that machine's backend offers.
 */
export const RPC_VERSION = 1;

/** The oldest backend this UI can drive on another machine. */
export const MIN_RPC_VERSION = 1;

/** A request the backend refused; `message` is written for the user. */
export class CeriumError extends Schema.TaggedError<CeriumError>()("CeriumError", {
  message: Schema.String,
}) {}

// Shared with Cerium's relay, which keeps a copy of every thread (docs/architecture.md §14.9).
export { ThreadOverview, UiEvent };

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
  /** Deletes a thread and everything in it for good; refused while its agents work or wait on the user. */
  Rpc.make("DeleteThread", { payload: { threadId: ThreadId }, error: CeriumError }),
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
  /** This machine's Cerium account (docs/architecture.md §14) now, then every change. */
  Rpc.make("WatchAccount", { success: AccountState, stream: true }),
  /** Starts signing this machine in; the UI opens `url`, where the user confirms in their browser. */
  Rpc.make("SignIn", { success: Schema.Struct({ url: Schema.String }), error: CeriumError }),
  Rpc.make("CancelSignIn", {}),
  /** Removes this machine from the account and forgets its sign-in. */
  Rpc.make("SignOut", { error: CeriumError }),
  /** Lets a device that's waiting for approval see and control the account's machines. */
  Rpc.make("ApproveDevice", { payload: { deviceId: DeviceId }, error: CeriumError }),
  Rpc.make("RenameDevice", { payload: { deviceId: DeviceId, name: DeviceName }, error: CeriumError }),
  /** Removes a device from the account: denies one waiting for approval, or signs one out. */
  Rpc.make("RemoveDevice", { payload: { deviceId: DeviceId }, error: CeriumError }),
  /**
   * Every thread of the account and what has been seen of them (§14.9), now and after every change.
   * Empty while this machine isn't signed in.
   */
  Rpc.make("WatchAccountThreads", { success: AccountThreads, stream: true }),
  /** Another machine's thread, read from the cloud copy: its events without streamed text. */
  Rpc.make("CloudThreadEvents", {
    payload: { machine: DeviceId, threadId: ThreadId },
    success: Schema.Array(UiEvent),
    error: CeriumError,
  }),
  /** Tells the account's other devices these threads were seen here. */
  Rpc.make("MarkThreadsRead", { payload: { entries: Schema.Array(ReadEntry) }, error: CeriumError }),
);
