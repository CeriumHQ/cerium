import {
  AccessMode,
  AccountDrafts,
  AccountState,
  AccountThreads,
  AgentId,
  AgentInfo,
  Attachment,
  CapabilityManifest,
  DeviceId,
  DeviceName,
  DraftEntry,
  EpochMillis,
  FromUser,
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
  RestorePreview,
  Settings,
  SettingsPatch,
  SkillInfo,
  SpendEdges,
  SpendReport,
  ThreadId,
  ThreadInfo,
  ThreadMode,
  ThreadNotification,
  ThreadOverview,
  ThreadOverviews,
  ThreadRef,
  TurnFilesReverted,
  UiEvent,
  UiEvents,
  UsageSnapshot,
  WorkspaceEntry,
  WorktreeChanges,
  ReadEntry,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup, RpcMessage } from "effect/rpc";

import { CeriumError } from "./error.ts";
import { FileBytes, FileDiff, FileListing, FilePreview, FileStatuses, FilesChanged } from "./files.ts";
import { GitRpcs } from "./git.ts";
import { GitBranchRpcs } from "./gitBranches.ts";
import { GitHubRpcs } from "./github.ts";
import { IssueRpcs } from "./githubIssues.ts";
import { CloneEvent, CommitDetail, CommitPage } from "./history.ts";
import { CommandTerminal, TerminalRpcs, TerminalSize } from "./terminal.ts";

export * from "./files.ts";
export * from "./git.ts";
export * from "./gitBranches.ts";
export * from "./github.ts";
export * from "./githubIssues.ts";
export * from "./history.ts";
export * from "./terminal.ts";

// The contract between the UI and the backend, served over a localhost WebSocket. Payloads and
// results are protocol schemas, so both sides validate them. Lists of threads and events skip what
// the reading side's version can't read.

/**
 * The version of this contract. Changes only add: a new RPC, or an optional field. Bump it with each
 * addition a client relies on, so a client driving another machine knows what that machine's backend
 * offers.
 */
export const RPC_VERSION = 20;

/** Which of a harness's own commands `RunHarnessCommand` runs. */
export const HarnessCommand = Schema.Literals(["login", "update"]);
export type HarnessCommand = typeof HarnessCommand.Type;

/** The oldest backend this UI can drive on another machine. */
export const MIN_RPC_VERSION = 1;

/**
 * What a tunnel to another machine says first (`openTunnel`'s `hello`): an RPC ping, which every
 * backend answers with one pong, so the tunnel opens only once the machine is there.
 */
export const TUNNEL_HELLO = JSON.stringify(RpcMessage.constPing);

export { CeriumError };

/** An artifact as the artifacts panel lists it: its page and where in which thread it was drawn. */
export const ListedArtifact = Schema.Struct({
  threadId: ThreadId,
  /** The message that holds it. */
  messageId: Schema.String,
  /** When that message was completed. */
  at: EpochMillis,
  code: Schema.String,
});
export type ListedArtifact = typeof ListedArtifact.Type;

// Shared with Cerium's relay, which keeps a copy of every thread.
export { ThreadOverview, UiEvent };

export const CreateThreadPayload = Schema.Struct({
  title: Schema.String,
  mode: ThreadMode,
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  /** A work thread runs in a git worktree of its own. Since `RPC_VERSION` 7. */
  worktree: Schema.optionalKey(Schema.Boolean),
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
    payload: {
      threadId: ThreadId,
      /**
       * Leaves out the images of tool outputs, each as a reference `ToolImage` reads (see
       * `withoutImages` in @cerium/protocol). Since `RPC_VERSION` 12; an older machine sends them.
       */
      withoutImages: Schema.optionalKey(Schema.Boolean),
    },
    success: UiEvents,
    error: CeriumError,
  }),
  /** An image `ThreadEvents` left out: the `index`th of a tool call's output. Since `RPC_VERSION` 12. */
  Rpc.make("ToolImage", {
    payload: { threadId: ThreadId, callId: Schema.NonEmptyString, index: Schema.Int },
    success: ImageData,
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
   * Sends a new version of one of the user's earlier messages to a lead: the conversation goes back
   * to before `messageId`, keeping what it replaces to look back on, and goes on from this one.
   * Since `RPC_VERSION` 11.
   */
  Rpc.make("EditMessage", {
    payload: {
      agentId: AgentId,
      messageId: Schema.NonEmptyString,
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(Attachment)),
      mentions: Schema.optionalKey(Schema.Array(Mention)),
    },
    error: CeriumError,
  }),
  /**
   * What restoring a lead's thread to before one of the user's messages would undo, to show before
   * it happens. Since `RPC_VERSION` 11.
   */
  Rpc.make("PreviewRestore", {
    payload: { agentId: AgentId, messageId: Schema.NonEmptyString },
    success: RestorePreview,
    error: CeriumError,
  }),
  /**
   * Restores a lead's thread to before one of the user's messages: its conversation, its agents and
   * the files they changed since. Answers with the message, for the user to send again or change.
   * Since `RPC_VERSION` 11.
   */
  Rpc.make("RestoreBefore", {
    payload: { agentId: AgentId, messageId: Schema.NonEmptyString },
    success: FromUser,
    error: CeriumError,
  }),
  /**
   * Puts the files one of an agent's turns changed (its `TurnFilesChanged`) back as they were before
   * it, or as it left them again; files changed since stay as they are. Since `RPC_VERSION` 19.
   */
  Rpc.make("RevertTurnFiles", {
    payload: {
      agentId: AgentId,
      turnId: Schema.NonEmptyString,
      direction: Schema.Literals(["undone", "redone"]),
    },
    success: TurnFilesReverted,
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
  /**
   * Hands a lead the user's messages waiting behind its turn now, interrupting the turn instead of
   * waiting for its next step. Since `RPC_VERSION` 19.
   */
  Rpc.make("SteerAgent", { payload: { agentId: AgentId }, error: CeriumError }),
  Rpc.make("StopAgent", { payload: { agentId: AgentId }, error: CeriumError }),
  /**
   * Stops all of a thread's work: interrupts every agent's turn and denies what waits on the user.
   * Answers with how many working agents it stopped and how many requests it denied. Since
   * `RPC_VERSION` 10.
   */
  Rpc.make("StopThread", {
    payload: { threadId: ThreadId },
    success: Schema.Struct({ agents: Schema.Number, approvals: Schema.Number }),
    error: CeriumError,
  }),
  /** The title is trimmed and must be 1 to 80 characters. */
  Rpc.make("RenameThread", {
    payload: { threadId: ThreadId, title: Schema.String },
    success: ThreadInfo,
    error: CeriumError,
  }),
  /**
   * Archiving hides a thread until it is restored; refused while its agents work or wait on the user.
   * A thread's worktree goes with it, refused while it holds work its base doesn't (`WorktreeChanges`)
   * unless `discardWork` (since `RPC_VERSION` 7); restoring puts it back.
   */
  Rpc.make("SetThreadArchived", {
    payload: {
      threadId: ThreadId,
      archived: Schema.Boolean,
      discardWork: Schema.optionalKey(Schema.Boolean),
    },
    success: ThreadInfo,
    error: CeriumError,
  }),
  /**
   * Deletes a thread and everything in it for good, its worktree too; refused while its agents work
   * or wait on the user, and, without `discardWork`, while its worktree holds unmerged work.
   */
  Rpc.make("DeleteThread", {
    payload: { threadId: ThreadId, discardWork: Schema.optionalKey(Schema.Boolean) },
    error: CeriumError,
  }),
  /** What a thread's worktree holds that its base doesn't; none without one. Since `RPC_VERSION` 7. */
  Rpc.make("WorktreeChanges", {
    payload: { threadId: ThreadId },
    success: WorktreeChanges,
    error: CeriumError,
  }),
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
   * The usage limits of each harness signed in with a subscription: the last reading at once, then
   * each change as the harnesses are read again (on subscribing, after their turns end, and every few
   * minutes). Harnesses without one are left out. Since `RPC_VERSION` 6.
   */
  Rpc.make("WatchSubscriptionUsage", { success: UsageSnapshot, stream: true }),
  /**
   * What the agents of this machine's threads used between the first and last of `edges`, in tokens
   * and in the cost harnesses reported, cut at each edge. Since `RPC_VERSION` 9.
   */
  Rpc.make("SpendReport", { payload: { edges: SpendEdges }, success: SpendReport, error: CeriumError }),
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
  /**
   * Runs a harness's own command in a terminal of no thread (`CommandTerminal`): `login`, its sign-in
   * command while it's signed out, or `update`, its `updateCommand`. The harness keeps whatever the
   * command creates. Since `RPC_VERSION` 20.
   */
  Rpc.make("RunHarnessCommand", {
    payload: { provider: ProviderId, action: HarnessCommand, size: TerminalSize },
    success: CommandTerminal,
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
  /**
   * An artifact drawn as a PNG to keep, as a page of its own in the user's theme, at twice `width`
   * in pixels; rendered in a browser on the machine.
   */
  Rpc.make("RenderArtifact", {
    payload: {
      html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5_000_000)),
      width: Schema.Int.check(Schema.isBetween({ minimum: 280, maximum: 2000 })),
      mode: Schema.Literals(["dark", "light"]),
      variables: Schema.Record(Schema.String, Schema.String),
    },
    success: ImageData,
    error: CeriumError,
  }),
  /**
   * The artifacts lead agents drew in the threads of a project (the folder, or worktrees of it),
   * newest first.
   */
  Rpc.make("ListArtifacts", {
    payload: { folder: Schema.NonEmptyString },
    success: Schema.Array(ListedArtifact),
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
  /** A file under `root` as the viewer shows it: its text up to a size, its kind of media, or neither. */
  Rpc.make("ReadFile", {
    payload: { root: Schema.NonEmptyString, path: Schema.NonEmptyString },
    success: FilePreview,
    error: CeriumError,
  }),
  /**
   * A file's bytes under `root`, in pieces small enough for the relay, for the viewer to play or show
   * a `Media` file. Refused past a size the viewer can hold.
   */
  Rpc.make("ReadFileBytes", {
    payload: { root: Schema.NonEmptyString, path: Schema.NonEmptyString },
    success: FileBytes,
    stream: true,
    error: CeriumError,
  }),
  /**
   * A changed file against the last commit; `from` is where it was before it was renamed, `context`
   * how many unchanged lines surround each change (3 when absent; a large number shows the whole file).
   */
  Rpc.make("DiffFile", {
    payload: {
      root: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      from: Schema.optionalKey(Schema.NonEmptyString),
      context: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    },
    success: FileDiff,
    error: CeriumError,
  }),
  /**
   * A page of the commits on the branch checked out in `root`, newest first, from `offset`; with a
   * `query`, only those whose message or author holds it, ignoring case. Since `RPC_VERSION` 17.
   */
  Rpc.make("CommitHistory", {
    payload: {
      root: Schema.NonEmptyString,
      query: Schema.optionalKey(Schema.String),
      offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    },
    success: CommitPage,
    error: CeriumError,
  }),
  /** One commit of `root`'s branch in full: its message and the files under `root` it changed. Since `RPC_VERSION` 17. */
  Rpc.make("CommitDetail", {
    payload: { root: Schema.NonEmptyString, sha: Schema.NonEmptyString },
    success: CommitDetail,
    error: CeriumError,
  }),
  /**
   * A file one of an agent's turns changed in the work folder `root`, between the snapshots from
   * before and after it (its `TurnFilesChanged`), shaped as `DiffFile` shapes a change against the
   * last commit. Since `RPC_VERSION` 19.
   */
  Rpc.make("TurnDiffFile", {
    payload: {
      root: Schema.NonEmptyString,
      before: Schema.NonEmptyString,
      after: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      context: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    },
    success: FileDiff,
    error: CeriumError,
  }),
  /**
   * A file a commit changed, against its first parent, shaped as `DiffFile` shapes a change against
   * the last commit. Since `RPC_VERSION` 17.
   */
  Rpc.make("CommitDiffFile", {
    payload: {
      root: Schema.NonEmptyString,
      sha: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      from: Schema.optionalKey(Schema.NonEmptyString),
      context: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    },
    success: FileDiff,
    error: CeriumError,
  }),
  /**
   * Clones `url` into a new folder named after it, inside `folder`, streaming git's progress until the
   * clone finishes with the folder it made. Since `RPC_VERSION` 17.
   */
  Rpc.make("CloneRepository", {
    payload: { url: Schema.NonEmptyString, folder: Schema.NonEmptyString },
    success: CloneEvent,
    stream: true,
    error: CeriumError,
  }),
  /** Makes `root` a git repository, as `git init` does. Since `RPC_VERSION` 17. */
  Rpc.make("InitRepository", { payload: { root: Schema.NonEmptyString }, error: CeriumError }),
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
).merge(TerminalRpcs, GitBranchRpcs, GitRpcs, GitHubRpcs, IssueRpcs);

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
  /** The account's drafts, now and after every change. Empty, and not ready, while signed out. */
  Rpc.make("WatchAccountDrafts", { success: AccountDrafts, stream: true }),
  /** Shares drafts written, sent or discarded here with the account's other devices. */
  Rpc.make("SaveDrafts", { payload: { drafts: Schema.Array(DraftEntry) }, error: CeriumError }),
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
  /**
   * Each time one of this device's own threads needs the user, finished or failed, once it settled,
   * signed in or not; a desktop shows it natively. Nothing for a browser.
   */
  Rpc.make("WatchNotifications", { success: ThreadNotification, stream: true }),
);

/** A desktop backend's own endpoint, for its own UI: the machine and the device. */
export const CeriumRpcs = MachineRpcs.merge(DeviceRpcs);
