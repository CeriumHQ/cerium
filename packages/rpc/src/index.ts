import {
  AccessMode,
  AccountState,
  AccountThreads,
  AgentId,
  AgentInfo,
  Attachment,
  CapabilityManifest,
  DeviceId,
  DeviceName,
  HarnessStatus,
  ImageData,
  LenientArray,
  LiveUiEvent,
  LoginProgress,
  Mention,
  ModelInfo,
  NotificationKind,
  ProjectInfo,
  PushSubscriptionInfo,
  ProviderId,
  QuestionResponse,
  ReasoningEffort,
  Settings,
  SettingsPatch,
  SkillInfo,
  ThreadId,
  ThreadInfo,
  ThreadMode,
  ThreadOverview,
  ThreadOverviews,
  ThreadRef,
  UiEvent,
  UiEvents,
  WorkspaceEntry,
  ReadEntry,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup, RpcMessage } from "effect/rpc";

import { CeriumError } from "./error.ts";
import { FileListing, FileStatuses, FilesChanged } from "./files.ts";
import { TerminalRpcs } from "./terminal.ts";

export * from "./files.ts";
export * from "./terminal.ts";

// The contract between the UI and the backend, served over a localhost WebSocket. Payloads and
// results are protocol schemas, so both sides validate them. Lists of threads and events skip what
// the reading side's version can't read.

/**
 * The version of this contract. Changes only add: a new RPC, or an optional field. Bump it with each
 * addition a client relies on, so a client driving another machine knows what that machine's backend
 * offers.
 */
export const RPC_VERSION = 5;

/** The oldest backend this UI can drive on another machine. */
export const MIN_RPC_VERSION = 1;

/**
 * What a tunnel to another machine says first (`openTunnel`'s `hello`): an RPC ping, which every
 * backend answers with one pong, so the tunnel opens only once the machine is there.
 */
export const TUNNEL_HELLO = JSON.stringify(RpcMessage.constPing);

export { CeriumError };

// Shared with Cerium's relay, which keeps a copy of every thread.
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

/** A thread whose messages match a search, and the passage around its best match in pieces. */
export const ThreadMatch = Schema.Struct({
  threadId: ThreadId,
  /** The matched words are the pieces marked `match`. */
  passage: Schema.Array(Schema.Struct({ text: Schema.String, match: Schema.Boolean })),
});
export type ThreadMatch = typeof ThreadMatch.Type;

/**
 * What a machine serves its own UI and, through tunnels, the account's other devices: its threads,
 * projects, harnesses and settings.
 */
export const MachineRpcs = RpcGroup.make(
  Rpc.make("ListThreads", { success: ThreadOverviews, error: CeriumError }),
  Rpc.make("ThreadEvents", {
    payload: { threadId: ThreadId },
    success: UiEvents,
    error: CeriumError,
  }),
  /**
   * Every agent's events as they happen, streaming deltas included; one of a kind the UI's version
   * doesn't know arrives as `undefined`.
   */
  Rpc.make("WatchEvents", { success: LiveUiEvent, stream: true }),
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
  /**
   * Switches a thread's lead to another model of its harness, or another effort, from its next turn.
   * Refused where `HarnessManifests` says the harness can't switch.
   */
  Rpc.make("SwitchModel", {
    payload: {
      agentId: AgentId,
      model: Schema.NonEmptyString,
      effort: Schema.optionalKey(ReasoningEffort),
    },
    success: AgentInfo,
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
  /** Answers or dismisses a question an agent asked with `ask_user`. Since `RPC_VERSION` 5. */
  Rpc.make("AnswerQuestion", {
    payload: {
      agentId: AgentId,
      requestId: Schema.NonEmptyString,
      response: QuestionResponse,
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
  /**
   * The threads of one mode whose messages, the user's or the agents', hold every word of `query`,
   * best match first, for the thread search.
   */
  Rpc.make("SearchThreads", {
    payload: { query: Schema.String, mode: ThreadMode },
    success: Schema.Array(ThreadMatch),
    error: CeriumError,
  }),
  Rpc.make("HarnessStatuses", { success: Schema.Array(HarnessStatus) }),
  /** What each installed adapter's harness can do; ones this version can't read are skipped. */
  Rpc.make("HarnessManifests", { success: LenientArray(CapabilityManifest) }),
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
  /**
   * One level of a folder inside a work thread's folder `root`, for the file explorer. `dir` is
   * relative to `root`, "" for `root` itself. Refused for anything outside `root`.
   */
  Rpc.make("ListFiles", {
    payload: { root: Schema.NonEmptyString, dir: Schema.String },
    success: FileListing,
    error: CeriumError,
  }),
  /** Which files under `root` differ from the last commit, as git sees them. */
  Rpc.make("FileStatuses", {
    payload: { root: Schema.NonEmptyString },
    success: FileStatuses,
    error: CeriumError,
  }),
  /**
   * What changes under `root` while it is subscribed to, in batches a moment apart, for keeping the
   * file explorer current. Unsubscribing stops watching.
   */
  Rpc.make("WatchFiles", {
    payload: { root: Schema.NonEmptyString },
    success: FilesChanged,
    stream: true,
    error: CeriumError,
  }),
  /** A project's own icon (its favicon, icon or logo), when it has one where projects keep them. */
  Rpc.make("ProjectIcon", {
    payload: { cwd: Schema.NonEmptyString },
    success: Schema.Struct({ icon: Schema.optionalKey(ImageData) }),
  }),
  Rpc.make("Settings", { success: Settings }),
  /** Changes the given settings; resolves with all of them. */
  Rpc.make("UpdateSettings", { payload: SettingsPatch, success: Settings, error: CeriumError }),
).merge(TerminalRpcs);

/**
 * What a device answers its own UI about itself: its Cerium account, the account's threads,
 * and whether its own agents are working. Never served through a tunnel: only a device's own UI
 * signs it in or out and manages the account's devices.
 */
export const DeviceRpcs = RpcGroup.make(
  /** This device's Cerium account now, then every change. */
  Rpc.make("WatchAccount", { success: AccountState, stream: true }),
  /** Starts signing this device in; the UI opens `url`, where the user confirms in their browser. */
  Rpc.make("SignIn", { success: Schema.Struct({ url: Schema.String }), error: CeriumError }),
  Rpc.make("CancelSignIn", {}),
  /** Removes this device from the account and forgets its sign-in. */
  Rpc.make("SignOut", { error: CeriumError }),
  /** Lets a device that's waiting for approval see and control the account's machines. */
  Rpc.make("ApproveDevice", { payload: { deviceId: DeviceId }, error: CeriumError }),
  Rpc.make("RenameDevice", { payload: { deviceId: DeviceId, name: DeviceName }, error: CeriumError }),
  /** Removes a device from the account: denies one waiting for approval, or signs one out. */
  Rpc.make("RemoveDevice", { payload: { deviceId: DeviceId }, error: CeriumError }),
  /**
   * Every thread of the account and what has been seen of them, now and after every change.
   * Empty while this device isn't signed in.
   */
  Rpc.make("WatchAccountThreads", { success: AccountThreads, stream: true }),
  /** Another machine's thread, read from the cloud copy: its events without streamed text. */
  Rpc.make("CloudThreadEvents", {
    payload: { machine: DeviceId, threadId: ThreadId },
    success: UiEvents,
    error: CeriumError,
  }),
  /** Tells the account's other devices these threads were seen here. */
  Rpc.make("MarkThreadsRead", { payload: { entries: Schema.Array(ReadEntry) }, error: CeriumError }),
  /**
   * Whether this device's own agents are working, now and after every change; always false for a
   * browser. The shell keeps a desktop awake for them while its window drives another machine.
   */
  Rpc.make("WatchWorking", { success: Schema.Boolean, stream: true }),
  /**
   * Whether this device's window shows, and the thread open in it: nobody is notified about a
   * thread someone is looking at.
   */
  Rpc.make("ReportPresence", {
    payload: { visible: Schema.Boolean, viewing: Schema.optionalKey(ThreadRef) },
  }),
  /** Sends this browser these kinds of push notifications from now on, at its subscription. */
  Rpc.make("SubscribePush", {
    payload: { subscription: PushSubscriptionInfo, kinds: Schema.Array(NotificationKind) },
    error: CeriumError,
  }),
  /** Sends this browser no more push notifications. */
  Rpc.make("UnsubscribePush", { error: CeriumError }),
);

/** A desktop backend's own endpoint, for its own UI: the machine and the device. */
export const CeriumRpcs = MachineRpcs.merge(DeviceRpcs);
