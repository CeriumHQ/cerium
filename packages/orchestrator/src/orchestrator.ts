import type {
  AgentSession,
  HarnessFailure,
  PermissionDecision,
  TurnExtras,
  TurnImage,
} from "@cerium/harness";
import {
  ADVISOR_ROLE,
  LEAD_ROLE,
  MAX_TASK_BYTES,
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  MAX_THREAD_TITLE,
  narrowAccess,
  REVIEWER_ROLE,
  type AccessMode,
  type AdvisorSettings,
  type AgentEvent,
  type Attachment,
  type AgentId,
  type AgentInfo,
  type AgentState,
  type EffortRouted,
  type EventId,
  type EventPayload,
  type FromAgent,
  type FromUser,
  type InputItem,
  type LeadHandedOff,
  type Mention,
  type ModelInfo,
  type ProviderId,
  type Question,
  type QuestionResponse,
  type ModelSpeed,
  type ReasoningEffort,
  type RestorePreview,
  type TaskEntry,
  type ThreadId,
  type ThreadInfo,
  type ThreadMode,
  type ThreadOverview,
  type ThreadWorktree,
  type TurnFilesReverted,
  type WorktreeChanges,
} from "@cerium/protocol";
import { Store, type StoreError, type ThreadPatch } from "@cerium/store";
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { Base64 } from "effect/encoding";

import {
  POLICY_VERSION,
  clipContext,
  selectEffort,
  supportedLevel,
  validProbabilities,
  DECISION_TIMEOUT,
  EffortDecider,
  effortState,
  likeliest,
  RECENT_EXCHANGES,
  type Exchange,
  type TurnFacts,
} from "./effort.ts";
import { notAllowed, notFound, OrchestratorError } from "./errors.ts";
import { Condenser, handoffBrief, olderTurns, pendingHandoff } from "./handoff.ts";
import { permissionNotice, renderTurn, systemPrompt, truncate, type Neighbour } from "./prompts.ts";
import { answerNotice, answerProblem, questionProblem, tidyResponse } from "./questions.ts";
import { planRestore, workSince } from "./restore.ts";
import { commandOf, FolderActivity, turnFiles, type TurnWork } from "./turnFiles.ts";
import { liveEvents, replayNotice, rewindPoint, startsAnew, undeliveredIds } from "./rewind.ts";
import { StreamedText } from "./streamed.ts";
import {
  Adapters,
  BusEndpoint,
  Catalog,
  Checkpoints,
  OrchestratorConfig,
  Worktrees,
  type CatalogEntry,
  type NewWorktree,
  type OrchestratorSettings,
  type WorktreeError,
} from "./services.ts";
import { UserSettings } from "./settings.ts";
import { ProjectScripts, type ScriptEnded, type ScriptStarted } from "./scripts.ts";
import { ThreadTitles } from "./titles.ts";

export interface CreateThreadInput {
  readonly title: string;
  readonly mode: ThreadMode;
  /** Required for work threads: the folder the agents work in. */
  readonly cwd?: string;
  /** A work thread runs in a git worktree of `cwd`'s repository of its own instead of `cwd` itself. */
  readonly worktree?: boolean;
  /** Shared by the threads one message starts together (multi agent). */
  readonly runId?: string;
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

/** What the user sent beside the text of a message. */
export interface UserMessageExtras {
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly mentions?: ReadonlyArray<Mention>;
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
}

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
  /** Whether it runs in a worktree of its own; as the caller's thread does without it. */
  readonly worktree?: boolean;
}

export type SpawnOutcome =
  | { readonly _tag: "Spawned"; readonly agentId: AgentId }
  | { readonly _tag: "PendingApproval"; readonly requestId: string };

export interface SpawnApproval {
  readonly decision: "allow" | "deny";
  /** The user may approve with a different model than the lead asked for. */
  readonly replacement?: { readonly provider: ProviderId; readonly model: string };
}

interface SpawnTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** The roster's speed for it; absent, the harness's own default. */
  readonly speed?: ModelSpeed;
}

/**
 * Questions an agent put to the user with `ask_user`, which returned at once: they wait for the
 * answers, which reach the agent as a notice whenever they come.
 */
type OpenQuestion = readonly [Question, ...Array<Question>];

/** How many `ask_user` calls an agent may have waiting at once. */
const MAX_OPEN_QUESTIONS = 4;

/** A live agent: the inbox Cerium delivers turns from, and its harness session once that has started. */
interface Runtime {
  info: AgentInfo;
  /** Undefined while the harness session starts; messages wait in the inbox meanwhile. */
  session: AgentSession | undefined;
  /** Settles once the session has started, or failed to. */
  started: Deferred.Deferred<AgentSession, OrchestratorError>;
  sessionScope: Scope.Closeable | undefined;
  readonly sessionPermit: Semaphore.Semaphore;
  sleeping: boolean;
  touchedAt: number;
  wakeSession: Effect.Effect<void>;
  readonly inbox: Queue.Queue<InputItem>;
  readonly scope: Scope.Closeable;
  sequence: number;
  /** Completed when the current turn's `TurnCompleted` arrives (or the session ends). */
  turn: Deferred.Deferred<void> | undefined;
  /** Held for each turn, so a compaction the user asked for never runs beside one. */
  readonly turnPermit: Semaphore.Semaphore;
  /** The last completed message of the current turn, delivered to the lead when a child finishes. */
  lastMessage: string | undefined;
  ended: boolean;
  /** The user stopped the turn in progress with "stop everything": its end wakes nobody. */
  halted: boolean;
  /** The user's messages wait in the inbox for the agent's next turn. */
  userWaiting: boolean;
  /** The tool calls of the turn in progress that haven't finished. */
  readonly openCalls: Set<string>;
  /** Cerium interrupted the turn in progress to hand the agent the user's waiting messages. */
  steering: boolean;
  /**
   * The model, effort and speed its harness session runs with; its next turn brings them in line with
   * `info`.
   */
  applied: ModelChoice;
  /** Its session is new and has run no turn: the one turn the router may route on any model. */
  fresh: boolean;
  /** The exchanges before its next turn, for the effort router; read from the store when first needed. */
  recent: Array<Exchange> | undefined;
  /** How its last turn went, for the effort router. */
  lastTurn: TurnFacts | undefined;
  /** The tool calls, failure and changed files of the turn in progress. */
  turnToolCalls: number;
  turnFailed: boolean;
  turnToolErrors: number;
  turnStopReason: string | undefined;
  effortDecision: EffortRouted | undefined;
  /**
   * On Auto, the level the effort router runs its turns at, in place of the level picked for it
   * (`info.effort`), which stays the one it falls back to.
   */
  routedEffort: ReasoningEffort | undefined;
  readonly turnFiles: Set<string>;
  /**
   * The provider's message last stored with one of its events. A message makes several events (an
   * edit of many files, a reply with tool calls), and each kept the whole of it again.
   */
  storedRaw: unknown;
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

const choiceOf = (info: AgentInfo): ModelChoice => ({
  model: info.model,
  ...(info.effort ? { effort: info.effort } : {}),
  ...(info.autoEffort ? { autoEffort: true } : {}),
  ...(info.speed ? { speed: info.speed } : {}),
});

/** A thread's advisor: the read-only child Cerium starts for `ask_advisor`. */
const isAdvisor = (info: AgentInfo) => info.parentId !== undefined && info.role === ADVISOR_ROLE;

/** A cross-harness reviewer: the read-only child Cerium starts for `startReview`. */
const isReviewer = (info: AgentInfo) => info.parentId !== undefined && info.role === REVIEWER_ROLE;

/** A child Cerium starts itself, whose answers go elsewhere than its lead: the advisor or a reviewer. */
const isHelper = (info: AgentInfo) => isAdvisor(info) || isReviewer(info);

const isImage = (attachment: Attachment) => attachment.mediaType.startsWith("image/");

/**
 * What resuming a lead reads of its history: the requests it waited on, the turns, messages and
 * rewinds of its conversation, and the agents it spawned. Its tool calls and their output, most of
 * a long history, say nothing about any of it.
 */
const RESUME_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "PermissionRequested",
  "PermissionResolved",
  "QuestionAsked",
  "QuestionResolved",
  "SpawnApprovalRequested",
  "SpawnApprovalResolved",
  "MessageQueued",
  "MessageWithdrawn",
  "MessageHeld",
  "TurnInput",
  "MessageCompleted",
  "SessionStarted",
  "ConversationRewound",
  "LeadHandedOff",
  "AgentSpawned",
];

/** What a handoff's brief reads of the lead's history: its conversation, files and plan. */
const BRIEF_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "TurnInput",
  "MessageCompleted",
  "ConversationRewound",
  "LeadHandedOff",
  "TurnFilesChanged",
  "FileChanged",
  "TodosUpdated",
];

/** Events the store never keeps: streamed text, and new titles, which the thread's record holds. */
const isEphemeral = (payload: EventPayload) =>
  payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta" || payload._tag === "ThreadRenamed";

/**
 * Read-only agents never wait on the user: each harness already keeps them from
 * writing, so Cerium approves what they ask itself. Tools of the user's own MCP servers still ask (the
 * user, or a child's lead), since those can change things outside Cerium; every adapter names them
 * `mcp__<server>…`.
 */
const approvesItself = (access: AccessMode, toolName: string) =>
  access === "readOnly" && !toolName.startsWith("mcp__");

type PermissionRequest = Extract<EventPayload, { readonly _tag: "PermissionRequested" }>;

const unavailable = (error: StoreError) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

const refusedWorktree = (error: WorktreeError) =>
  new OrchestratorError({ reason: "invalid", message: error.message });

/** How archiving or deleting a thread treats the work in its worktree. */
export interface PutAwayOptions {
  /**
   * The user saw what the worktree holds that its base doesn't and still wants it gone. Without it, a
   * worktree with uncommitted changes or unmerged commits keeps its thread from being put away.
   */
  readonly discardWork?: boolean;
}

/** What a worktree's changes are, in words, for the refusal that asks the user to confirm. */
const describeChanges = ({ uncommitted, unmerged }: WorktreeChanges, base: string) =>
  [
    uncommitted > 0 ? `${uncommitted} uncommitted ${uncommitted === 1 ? "change" : "changes"}` : undefined,
    unmerged > 0 ? `${unmerged} ${unmerged === 1 ? "commit" : "commits"} not merged into ${base}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" and ");

/** What the lead hears when the worktree was made: what setup runs there, or that none is set. */
const setupNote = (ran: ScriptStarted | undefined): string =>
  ran === undefined
    ? "No setup command is set for this project, so the worktree may lack what it needs. Ask the user to set one in Settings → Source control, or install what's missing yourself."
    : ran._tag === "Ran"
      ? `The project's setup (\`${ran.script}\`) is running in this thread's terminal. Wait for the notice of it finishing or failing before relying on what it installs.`
      : `Cerium guesses the setup \`${ran.script}\` for this project, but a guess never runs by itself. Ask the user to confirm it in Settings → Source control (or press Setup); until then, wait for what it looks for.`;

/** What the lead hears when a script's run is over. */
const endedNote = (ended: ScriptEnded): string => {
  const what = `The project's ${ended.kind} (\`${ended.script}\`)`;
  return ended.code === 0
    ? `${what} finished.`
    : ended.code === undefined
      ? `${what} stopped (its terminal was closed).`
      : `${what} failed with exit code ${ended.code}; its terminal shows why.`;
};

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    createThread(
      input: CreateThreadInput,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    /** Delivers the user's message to a lead, resuming its harness session if it stopped or failed. */
    sendUserMessage(
      agentId: AgentId,
      text: string,
      extras?: UserMessageExtras,
    ): Effect.Effect<void, OrchestratorError>;
    /**
     * Sends a new version of one of the user's earlier messages to a lead: the conversation goes back
     * to before that message (see `rewindLead`) and goes on from the new one.
     */
    editMessage(
      agentId: AgentId,
      messageId: string,
      text: string,
      extras?: UserMessageExtras,
    ): Effect.Effect<void, OrchestratorError>;
    /**
     * Takes a lead's conversation back to before one of the user's messages, which it resolves with.
     * Its harness forks its session there where it can; otherwise a new session is told the
     * conversation so far with the next message. A running turn stops, the agents the replaced turns
     * spawned stop, and the thread keeps the replaced turns to look back on. Files are left as they are.
     */
    rewindLead(agentId: AgentId, messageId: string): Effect.Effect<FromUser, OrchestratorError>;
    /**
     * What restoring a lead's thread to before one of the user's messages would undo: the messages
     * from it on, how the conversation goes back, the agents that stop, and the files put back.
     */
    previewRestore(agentId: AgentId, messageId: string): Effect.Effect<RestorePreview, OrchestratorError>;
    /**
     * Restores a lead's thread to before one of the user's messages, which it resolves with: the
     * conversation goes back (see `rewindLead`), the thread's other agents stop, and the files its
     * agents changed since are put back as they were, except those another thread changed too.
     */
    restoreBefore(agentId: AgentId, messageId: string): Effect.Effect<FromUser, OrchestratorError>;
    /**
     * Puts the files one of an agent's turns changed back as they were before it (`undone`), or as the
     * turn left them (`redone`); a file changed since is left as it is. Records and resolves with what
     * it did.
     */
    revertTurn(
      agentId: AgentId,
      turnId: string,
      direction: "undone" | "redone",
    ): Effect.Effect<TurnFilesReverted, OrchestratorError>;
    /**
     * Switches a thread's lead to another model of its harness, or another effort or speed, from its
     * next turn. A lead that stopped or failed starts on them when the user picks the thread back up.
     */
    switchModel(agentId: AgentId, choice: ModelChoice): Effect.Effect<AgentInfo, OrchestratorError>;
    /**
     * Hands a thread's lead to a model of another harness: a running turn stops, its session ends, and
     * a new session starts on `target` in the same folder, told the conversation so far with its next
     * turn (recent turns word for word, older ones condensed, the files the thread changed and its
     * plan). Only that text crosses over. The lead keeps its id, so the agents it spawned go on and
     * report to the new session.
     */
    handOffLead(agentId: AgentId, target: HandoffTarget): Effect.Effect<AgentInfo, OrchestratorError>;
    respondToPermission(
      agentId: AgentId,
      requestId: string,
      decision: PermissionDecision,
    ): Effect.Effect<void, OrchestratorError>;
    /**
     * Answers a question an agent asked the user, or dismisses it. Refused once the question is
     * closed: answered, expired when its turn was interrupted or its session ended, or its agent gone.
     */
    answerQuestion(
      agentId: AgentId,
      requestId: string,
      response: QuestionResponse,
    ): Effect.Effect<void, OrchestratorError>;
    resolveSpawnApproval(requestId: string, approval: SpawnApproval): Effect.Effect<void, OrchestratorError>;
    /**
     * A lead's answer to a permission request of one of its children, which Cerium hands the lead
     * instead of the user. Refused once the request is closed or when the child isn't the caller's.
     */
    answerChildPermission(
      callerId: AgentId,
      childId: AgentId,
      requestId: string,
      decision: PermissionDecision,
    ): Effect.Effect<void, OrchestratorError>;
    /** Interrupts the agent's current turn; children follow when configured or asked. */
    interruptAgent(
      agentId: AgentId,
      options?: { readonly includeChildren?: boolean },
    ): Effect.Effect<void, OrchestratorError>;
    /**
     * Hands a lead the user's messages waiting behind its turn now, interrupting the turn rather than
     * waiting for its tool calls to finish. Does nothing when no message waits or no turn is running.
     */
    steerAgent(agentId: AgentId): Effect.Effect<void, OrchestratorError>;
    /**
     * Asks the agent's harness to compact its conversation, as a turn of its own that starts at once.
     * Refused while the agent works, and for a harness that can't compact when asked.
     */
    compactAgent(agentId: AgentId): Effect.Effect<void, OrchestratorError>;
    /**
     * Takes back one of the user's messages waiting for a lead, so no turn delivers it. False when the
     * agent has already taken it.
     */
    withdrawMessage(agentId: AgentId, messageId: string): Effect.Effect<boolean, OrchestratorError>;
    /** Ends the agent's session. */
    stopAgent(agentId: AgentId): Effect.Effect<void, OrchestratorError>;
    /**
     * Stops all of a thread's work at once: every agent's turn is interrupted, what waits on the user
     * (permission requests, a lead's spawn requests, questions) is denied or closed, and nothing queued
     * or reported by the stopped turns starts another. Sessions stay open for the user's next message.
     * Returns how many working agents it stopped and how many requests it denied.
     */
    stopThread(
      threadId: ThreadId,
    ): Effect.Effect<{ readonly agents: number; readonly approvals: number }, OrchestratorError>;
    readonly listThreads: Effect.Effect<ReadonlyArray<ThreadInfo>, OrchestratorError>;
    /** Renames a thread; the title is trimmed and must be 1 to `MAX_THREAD_TITLE` characters. */
    renameThread(threadId: ThreadId, title: string): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * Archives or restores a thread. One whose agents are working or waiting on the user can't be
     * archived, so a request never ends up where the user doesn't look. Archiving a thread that runs
     * in a worktree ends its sessions and removes the worktree, refused while it holds work its base
     * doesn't unless `discardWork`; restoring puts the worktree back.
     */
    setThreadArchived(
      threadId: ThreadId,
      archived: boolean,
      options?: PutAwayOptions,
    ): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * Puts a thread off until `until`, when it comes back to the user's inbox; `undefined` brings it
     * back now. Archiving a thread ends its wait.
     */
    setThreadLater(
      threadId: ThreadId,
      until: number | undefined,
    ): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * Deletes a thread for good: its agents' sessions end and its agents and events are removed, and
     * its worktree with them. Refused while its agents work or wait on the user, like archiving.
     */
    deleteThread(threadId: ThreadId, options?: PutAwayOptions): Effect.Effect<void, OrchestratorError>;
    /** What a thread's worktree holds that its base doesn't; none for a thread without one. */
    worktreeChanges(threadId: ThreadId): Effect.Effect<WorktreeChanges, OrchestratorError>;
    listAgents(threadId: ThreadId): Effect.Effect<ReadonlyArray<AgentInfo>, OrchestratorError>;
    /** Every thread with its agents and whether it waits on the user, oldest first, read at once. */
    readonly threadOverviews: Effect.Effect<ReadonlyArray<ThreadOverview>, OrchestratorError>;
    /** Live events from every agent; subscribers see events published after they subscribe. */
    readonly events: Stream.Stream<AgentEvent>;

    // Bus-facing operations: `callerId` is the agent invoking the tool.
    /** Waits for the catalog while the backend is still learning it from the harnesses. */
    readonly catalog: Effect.Effect<ReadonlyArray<CatalogEntry>>;
    spawn(callerId: AgentId, request: SpawnRequest): Effect.Effect<SpawnOutcome, OrchestratorError>;
    /**
     * Starts a thread for the user at a lead's request, in the lead's folder and mode, whose own lead
     * begins on the prompt as the user's message, marked as written by the caller.
     */
    startThread(
      callerId: AgentId,
      request: ThreadRequest,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    /**
     * Delivers an agent's message. One to another thread's lead waits for that lead's next turn,
     * unless the sender asks for a `reply` or answers one the receiver asked for: then, as within a
     * thread, it starts the receiver's turn once it is idle. Resolves with whether it waits.
     */
    sendMessage(
      callerId: AgentId,
      to: AgentId,
      text: string,
      options?: { readonly reply?: boolean },
    ): Effect.Effect<{ readonly held: boolean }, OrchestratorError>;
    killChild(callerId: AgentId, childId: AgentId): Effect.Effect<void, OrchestratorError>;
    /**
     * Puts a question to the thread's advisor, starting one on the model the user picked when none
     * runs. Returns at once; the answer reaches the caller later, as a message from the advisor.
     */
    askAdvisor(
      callerId: AgentId,
      question: string,
    ): Effect.Effect<{ readonly advisorId: AgentId }, OrchestratorError>;
    /**
     * Starts a cross-harness reviewer in a thread: a read-only child of its lead on `reviewer`, in the
     * thread's folder, told `prompt`. Its final message of that turn is the review, which `reply`
     * resolves with, and goes nowhere else: the lead never hears it. It stops once it has answered, and
     * `reply` fails when it ends before then.
     */
    startReview(
      threadId: ThreadId,
      reviewer: { readonly provider: ProviderId; readonly model: string; readonly effort?: ReasoningEffort },
      prompt: string,
    ): Effect.Effect<
      { readonly agentId: AgentId; readonly reply: Effect.Effect<string, OrchestratorError> },
      OrchestratorError
    >;
    /**
     * Puts questions to the user for an agent: `ask_user`, the only question tool agents have. Returns
     * at once; the user's answer reaches the caller later, as a notice.
     */
    askUser(
      callerId: AgentId,
      questions: readonly [Question, ...Array<Question>],
    ): Effect.Effect<{ readonly requestId: string }, OrchestratorError>;
    /**
     * What a window mirrors of the user's tasks onto this machine, feeding `list_tasks`'s view of
     * them. An entry newer than what's held wins; what one holds is only ever a copy, the window's
     * list the truth.
     */
    syncUserTasks(tasks: ReadonlyArray<TaskEntry>): Effect.Effect<void>;
    /** Adds a task to the user's tasks list, and returns the entry it now holds. */
    addUserTask(
      callerId: AgentId,
      task: { readonly title: string; readonly note?: string; readonly folder?: string },
    ): Effect.Effect<TaskEntry, OrchestratorError>;
    /** Takes a task off the user's tasks list, by the id or the title it matches, and returns it. */
    removeUserTask(
      callerId: AgentId,
      which: { readonly id?: string; readonly title?: string },
    ): Effect.Effect<TaskEntry, OrchestratorError>;
    /** The user's tasks still on the list, as the windows mirroring them last left them. */
    readonly userTasks: Effect.Effect<ReadonlyArray<TaskEntry>>;
    /** The agent record for a live agent. */
    agent(agentId: AgentId): Effect.Effect<AgentInfo, OrchestratorError>;
    /** Hands a live agent a Cerium notice, delivered like any message: as its next turn's input. */
    notify(agentId: AgentId, text: string): Effect.Effect<void>;
    /**
     * Hands an agent a Cerium notice it must act on: a lead whose session stopped is picked back up
     * for it, as for the user's message. A child that ended can't be, and is refused.
     */
    wake(agentId: AgentId, text: string): Effect.Effect<void, OrchestratorError>;
    /**
     * Asks before one of Cerium's own tools does what a harness asks about, such as `push` running
     * git, by the caller's access as a command is: read-only refuses, `auto` and full access allow,
     * and the other modes ask the user (a child's lead) with a request like a harness's. An allow for
     * the session stands for the agent's later calls of the same tool.
     */
    requestApproval(
      callerId: AgentId,
      request: { readonly toolName: string; readonly summary: string; readonly input: unknown },
    ): Effect.Effect<PermissionDecision, OrchestratorError>;
    /**
     * Every persisted event in a thread, in order. With `streamed`, each block still streaming follows
     * them as one delta holding its text so far, in its first delta's place: streamed text is never
     * stored, and a reader joining mid-reply would otherwise start it partway through.
     */
    threadEvents(
      threadId: ThreadId,
      options?: { readonly streamed?: boolean; readonly withoutImages?: boolean },
    ): Effect.Effect<ReadonlyArray<AgentEvent>, OrchestratorError>;
    /**
     * Whether the thread waits for the user: its lead's permission request (a child's goes to the lead),
     * the lead's request to start an agent outside the catalog, or a question an agent asked.
     */
    awaitingApproval(threadId: ThreadId): boolean;
  }
>()("cerium/orchestrator/Orchestrator") {
  static readonly layer = Layer.effect(
    Orchestrator,
    Effect.gen(function* () {
      const store = yield* Store;
      const adapters = yield* Adapters;
      const catalog = yield* Catalog;
      const bus = yield* BusEndpoint;
      const config = yield* OrchestratorConfig;
      const settings = yield* UserSettings;
      const decider = Option.getOrElse(yield* Effect.serviceOption(EffortDecider), () => EffortDecider.none);
      /** The effort router runs: the user turned it on and its decision model has a key. */
      const routerOn = Effect.gen(function* () {
        return (yield* settings.get).effortRouter.enabled && (yield* decider.ready);
      });
      const titles = yield* ThreadTitles;
      const condenser = yield* Condenser;
      const worktrees = yield* Worktrees;
      const checkpoints = yield* Checkpoints;
      const scripts = yield* ProjectScripts;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const layerScope = yield* Scope.Scope;
      // Agents' sessions live in their own scope, which closes after the finalizer below that stops
      // each agent: closed first, a session would end under a live agent and mark it failed, as new
      // activity in its thread.
      const agentsScope = yield* Scope.fork(layerScope);

      const runtimes = new Map<AgentId, Runtime>();
      const threadDirectories = new Map<ThreadId, string>();
      const threadModes = new Map<ThreadId, ThreadMode>();
      /** The worktree of each live thread that runs in one, for its agents' instructions. */
      const threadWorktrees = new Map<ThreadId, ThreadWorktree>();
      const pendingSpawns = new Map<string, { readonly leadId: AgentId; readonly request: SpawnRequest }>();
      /** Send times per `from->to` pair, for the message budget. */
      const sentMessages = new Map<string, Array<number>>();
      /** Permission requests each agent is waiting on. */
      const pendingPermissions = new Map<AgentId, Set<string>>();
      /** Permission requests each child is waiting on its lead to answer; the user never sees them. */
      const leadRequests = new Map<AgentId, Set<string>>();
      /** The questions each agent has put to the user and not had answered, by request id. */
      const openQuestions = new Map<AgentId, Map<string, OpenQuestion>>();
      /** Requests Cerium raised for its own tools (`requestApproval`), by request id: no harness waits on them. */
      const ownRequests = new Map<
        string,
        {
          readonly agentId: AgentId;
          readonly toolName: string;
          readonly done: Deferred.Deferred<PermissionDecision>;
        }
      >();
      /** The tools each agent was allowed for the rest of its session through `requestApproval`. */
      const allowedTools = new Map<AgentId, Set<string>>();

      /**
       * What the windows mirroring in say the user's tasks list holds, plus what agents added while
       * they worked: the view `list_tasks` reads and `remove_task` matches titles against. A copy,
       * merged newer-wins like the window's own (`applyTaken` in the UI): the window's list is the
       * truth, and its next mirror overwrites anything this found out earlier. Deleted tasks keep
       * their stamps (no `task`) a while, so a mirror older than a delete can't bring one back.
       */
      const mirroredTasks = new Map<string, TaskEntry>();

      /**
       * Notices each agent hears with its next turn, whatever starts it, rather than starting one: a
       * dismissed question, or another thread's heads-up, isn't worth waking an agent whose context may
       * hold hundreds of thousands of tokens.
       */
      const heldNotices = new Map<AgentId, Array<InputItem>>();
      /**
       * The other threads' leads each lead asked with `reply`, whose next message to it starts its turn
       * rather than waiting: the answer it ended its turn to wait for.
       */
      const awaitedReplies = new Map<AgentId, Set<AgentId>>();
      /** Each thread's live advisor. */
      const advisors = new Map<ThreadId, Runtime>();
      /** The agents waiting on each advisor's answers, in the order they asked. */
      const advisorQuestions = new Map<AgentId, Array<AgentId>>();
      /** One advisor starts at a time, so agents asking together share it. */
      const advisorPermit = yield* Semaphore.make(1);
      /** Each live reviewer's review, settled with its final message once its turn ends. */
      const reviews = new Map<AgentId, Deferred.Deferred<string, OrchestratorError>>();
      const feed = yield* PubSub.unbounded<AgentEvent>();
      /** Threads still waiting for their first message to name them, with the title they started with. */
      const untitled = new Map<ThreadId, string>();
      /** What a lead picked back up after a rewind keeps for the user's next message. */
      const held = new Map<
        AgentId,
        { readonly undelivered: ReadonlyArray<InputItem>; readonly notices: ReadonlyArray<InputItem> }
      >();
      /** The leads handed to another harness whose new session hasn't heard the conversation yet. */
      const briefsOwed = new Map<AgentId, LeadHandedOff>();

      // Sessions don't survive a restart, so agents a previous run left live are stopped; a lead
      // resumes its harness session when the user next messages it.
      yield* store.stopLiveAgents.pipe(Effect.mapError(unavailable));
      /**
       * One user message accepted at a time, so messages sent together keep their order and don't
       * start two sessions for one lead.
       */
      const acceptPermit = yield* Semaphore.make(1);

      // A script's run ending reaches its thread's lead as any notice does, so it knows when the
      // setup is through: without one, its work would race the install.
      yield* scripts.ended.pipe(
        Stream.runForEach((ended) =>
          Effect.forEach(
            [...runtimes.values()].filter(
              (rt) => rt.info.threadId === ended.threadId && rt.info.parentId === undefined,
            ),
            (rt) => deliver(rt.info.id, { _tag: "SystemNotice", text: endedNote(ended) }),
            { discard: true },
          ),
        ),
        Effect.forkIn(layerScope),
      );

      const makeId = (prefix: string) =>
        crypto.randomUUIDv7().pipe(
          Effect.map((uuid) => `${prefix}_${uuid}`),
          Effect.orDie,
        );

      const runtime = (agentId: AgentId) =>
        Effect.fromNullishOr(runtimes.get(agentId)).pipe(
          Effect.mapError(() => notFound(`Agent ${agentId} is not running.`)),
        );

      /** The `add_task` and `remove_task` caller rules: live, part of a thread, neither read-only nor the advisor. */
      const tasksWriterOf = (callerId: AgentId) =>
        Effect.gen(function* () {
          const caller = yield* runtime(callerId);
          if (isAdvisor(caller.info)) {
            return yield* notAllowed("You are the advisor: answer the question you were asked.");
          }
          if (caller.info.access === "readOnly") {
            return yield* notAllowed("A read-only agent may only read the tasks list.");
          }
          return caller;
        });

      /** Enters the mirror a task entry stamped past the newest edit it knew of: a same-millisecond
       * edit wins, as the window's own (`stampAfter`) does. */
      const putTask = (change: { readonly id: string; readonly task?: Schema.Json }) =>
        Effect.gen(function* () {
          const stamped: TaskEntry = {
            id: change.id,
            updatedAt: Math.max(
              yield* Clock.currentTimeMillis,
              (mirroredTasks.get(change.id)?.updatedAt ?? 0) + 1,
            ),
            ...(change.task === undefined ? {} : { task: change.task }),
          };
          mirroredTasks.set(stamped.id, stamped);
          return stamped;
        });

      /** The one task `title` names, whatever its case and spacing; `notFound` when none, and when
       * several: the agent names one by its id then. */
      const taskByTitle = (title: string) => {
        const wanted = title.trim().toLowerCase();
        const matching = [...mirroredTasks.values()].filter((entry) => {
          const task = entry.task;
          const named =
            typeof task === "object" && task !== null && !Array.isArray(task)
              ? (task as { readonly title?: unknown }).title
              : undefined;
          return typeof named === "string" && named.trim().toLowerCase() === wanted;
        });
        if (matching.length <= 1) return Effect.succeed(matching[0]);
        return new OrchestratorError({
          reason: "invalid",
          message: `The list has ${matching.length} tasks titled \u201C${title.trim()}\u201D (${matching
            .map((entry) => entry.id)
            .join(", ")}). Pass one's id from \`list_tasks\`.`,
        });
      };

      /** Who works in each work folder when, by its resolved path, for each turn's summary of its files. */
      const activities = new Map<string, FolderActivity>();
      /** Each agent's turn in progress in a work folder: when it began, and the commands it has run. */
      const turnsInProgress = new Map<
        AgentId,
        { readonly folder: string; readonly start: number; readonly commands: Array<string> }
      >();

      const activityIn = (folder: string) => {
        const resolved = path.resolve(folder);
        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        let activity = activities.get(key);
        if (activity === undefined) {
          activity = new FolderActivity();
          activities.set(key, activity);
        }
        return activity;
      };

      /** Notes what an agent's event says it did in its turn: a file its edit tools named, a command it ran. */
      const noteWork = (agentId: AgentId, at: number, payload: EventPayload) => {
        const turn = turnsInProgress.get(agentId);
        if (turn === undefined) return;
        if (payload._tag === "FileChanged") {
          const relative = path.relative(turn.folder, path.resolve(turn.folder, payload.path));
          if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
            activityIn(turn.folder).name(agentId, at, relative.replaceAll("\\", "/"));
          }
        }
        if (payload._tag === "ToolCallStarted") {
          const command = commandOf(payload.toolName, payload.input);
          if (command !== undefined) turn.commands.push(command);
        }
      };

      const streamed = new StreamedText();

      /** Stores (unless it's ephemeral) and publishes one of an agent's events, at `sequence`. */
      const record = (info: AgentInfo, sequence: number, payload: EventPayload, raw?: unknown) =>
        Effect.gen(function* () {
          const event = streamed.note({
            id: `${info.id}:${sequence}` as EventId,
            threadId: info.threadId,
            agentId: info.id,
            sequence,
            at: yield* Clock.currentTimeMillis,
            payload,
            ...(raw === undefined ? {} : { raw }),
          });
          noteWork(info.id, event.at, payload);
          if (!isEphemeral(payload)) yield* store.appendEvents([event]).pipe(Effect.mapError(unavailable));
          yield* PubSub.publish(feed, event);
        });

      /** Records a runtime's event, keeping the provider's message only with the first it makes. */
      const emit = (rt: Runtime, payload: EventPayload, raw?: unknown) =>
        Effect.suspend(() => {
          const original = raw !== undefined && raw === rt.storedRaw ? undefined : raw;
          if (original !== undefined && !isEphemeral(payload)) rt.storedRaw = original;
          return record(rt.info, rt.sequence++, payload, original);
        });

      /** Records an event of an agent that has no runtime, such as a lead stopped before a restart. */
      const emitStored = (info: AgentInfo, payload: EventPayload) =>
        Effect.gen(function* () {
          const last = yield* store.lastSequence(info.id).pipe(Effect.mapError(unavailable));
          yield* record(info, Option.match(last, { onNone: () => 0, onSome: (at) => at + 1 }), payload);
        });

      /**
       * Records the model, effort and speed an agent runs with from its next turn: on its runtime, if it
       * has one, in the store, and in its transcript. A lead with no runtime starts its next session on
       * them.
       */
      const recordModel = (info: AgentInfo, rt: Runtime | undefined, choice: ModelChoice) =>
        Effect.gen(function* () {
          const updatedAt = yield* Clock.currentTimeMillis;
          const { effort: _previous, autoEffort: _wasAuto, speed: _speed, ...rest } = info;
          const autoEffort = choice.autoEffort === true;
          const next: AgentInfo = {
            ...rest,
            model: choice.model,
            ...(choice.effort ? { effort: choice.effort } : {}),
            ...(autoEffort ? { autoEffort } : {}),
            ...(choice.speed ? { speed: choice.speed } : {}),
            updatedAt,
          };
          // Stored first, so a switch the store refused isn't half made: the next turn and the next
          // start of the session agree on what the agent runs.
          yield* store
            .updateAgent(info.id, {
              model: choice.model,
              effort: choice.effort ?? null,
              autoEffort,
              speed: choice.speed ?? null,
              updatedAt,
            })
            .pipe(Effect.mapError(unavailable));
          if (rt !== undefined) rt.info = next;
          const payload: EventPayload = { _tag: "ModelChanged", ...choiceOf(next) };
          yield* rt === undefined ? emitStored(next, payload) : emit(rt, payload);
          return next;
        });

      const deliver = (agentId: AgentId, item: InputItem) =>
        Effect.gen(function* () {
          const target = runtimes.get(agentId);
          if (target === undefined || target.ended) {
            return yield* Effect.logWarning(`Dropped ${item._tag} for ${agentId}: agent is not running`);
          }
          target.touchedAt = Date.now();
          yield* Queue.offer(target.inbox, item);
        });

      /** A turn's items, after the notices held for the agent's next turn, which it takes. */
      const withHeld = (
        agentId: AgentId,
        items: readonly [InputItem, ...Array<InputItem>],
      ): readonly [InputItem, ...Array<InputItem>] => {
        const [head, ...tail] = heldNotices.get(agentId) ?? [];
        heldNotices.delete(agentId);
        return head === undefined ? items : [head, ...tail, ...items];
      };

      /** An advisor that ended answers nobody: the agents still waiting on it hear so, and ask anew. */
      const releaseAdvisor = (rt: Runtime) =>
        Effect.gen(function* () {
          const waiting = advisorQuestions.get(rt.info.id) ?? [];
          advisorQuestions.delete(rt.info.id);
          if (advisors.get(rt.info.threadId) === rt) advisors.delete(rt.info.threadId);
          yield* Effect.forEach(
            new Set(waiting),
            (asker) =>
              deliver(asker, {
                _tag: "SystemNotice",
                text: "The advisor ended before it answered your question. Ask again with `ask_advisor` if you still need an answer.",
              }),
            { discard: true },
          );
        });

      /** A reviewer that ended before it answered leaves its review failed. */
      const releaseReview = (rt: Runtime) =>
        Effect.gen(function* () {
          const review = reviews.get(rt.info.id);
          reviews.delete(rt.info.id);
          if (review === undefined) return;
          yield* Deferred.fail(
            review,
            new OrchestratorError({
              reason: "unavailable",
              message: `${rt.info.model} stopped before it finished the review.`,
            }),
          );
        });

      const setState = (rt: Runtime, state: AgentState) =>
        Effect.gen(function* () {
          if (rt.info.state === state) return;
          // Stopping isn't activity: agents stop as the app quits, and that mustn't make their
          // threads unread or reorder them.
          const updatedAt = state === "stopped" ? rt.info.updatedAt : yield* Clock.currentTimeMillis;
          rt.info = { ...rt.info, state, updatedAt };
          yield* store.updateAgent(rt.info.id, { state, updatedAt }).pipe(Effect.mapError(unavailable));
          yield* emit(rt, { _tag: "AgentStateChanged", state });
          if (isAdvisor(rt.info) && (state === "stopped" || state === "failed")) yield* releaseAdvisor(rt);
          if (isReviewer(rt.info) && (state === "stopped" || state === "failed")) yield* releaseReview(rt);
        });

      const finishTurn = (rt: Runtime) =>
        rt.turn === undefined ? Effect.void : Deferred.succeed(rt.turn, undefined);

      /**
       * Hands the agent the user's messages waiting behind its turn: the turn is interrupted, and they
       * start the next one, the same way on every harness. So a message reaches the agent at its next
       * step rather than once it is done: Cerium steers when the turn's tool calls have all finished,
       * or at once when the user asks.
       */
      const steer = (rt: Runtime) =>
        Effect.gen(function* () {
          const session = rt.session;
          if (rt.turn === undefined || !rt.userWaiting || rt.steering || session === undefined) return;
          rt.steering = true;
          yield* session.interrupt.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // The messages wait for the turn's end instead.
                rt.steering = false;
                yield* Effect.logWarning(`Couldn't steer agent ${rt.info.id}: ${error.message}`);
              }),
            ),
          );
        });

      /** Takes a question out of those waiting; what it was, or nothing when it was not waiting. */
      const closeQuestion = (agentId: AgentId, requestId: string): OpenQuestion | undefined => {
        const open = openQuestions.get(agentId);
        const found = open?.get(requestId);
        open?.delete(requestId);
        if (open?.size === 0) openQuestions.delete(agentId);
        return found;
      };

      /** Closes the agent's waiting questions as expired: it was stopped or interrupted, or its session ended. */
      const expireQuestions = (rt: Runtime) =>
        Effect.forEach(
          [...(openQuestions.get(rt.info.id)?.keys() ?? [])],
          (requestId) => {
            closeQuestion(rt.info.id, requestId);
            return emit(rt, { _tag: "QuestionResolved", requestId, outcome: "expired" });
          },
          { discard: true },
        );

      const closeLeadRequest = (childId: AgentId, requestId: string) => {
        const open = leadRequests.get(childId);
        const found = open?.delete(requestId) ?? false;
        if (open?.size === 0) leadRequests.delete(childId);
        return found;
      };

      /** Answers a permission request an agent waits on: its harness's, or one Cerium raised for its own tool. */
      const answerRequest = (rt: Runtime, requestId: string, decision: PermissionDecision) =>
        Effect.gen(function* () {
          const own = ownRequests.get(requestId);
          if (own === undefined) {
            return yield* (yield* sessionOf(rt)).respondToPermission(requestId, decision);
          }
          ownRequests.delete(requestId);
          closeLeadRequest(own.agentId, requestId);
          if (decision.decision === "allow" && decision.scope === "session") {
            allowedTools.set(own.agentId, (allowedTools.get(own.agentId) ?? new Set()).add(own.toolName));
          }
          if (pendingPermissions.get(rt.info.id)?.delete(requestId) === true) {
            yield* emit(rt, {
              _tag: "PermissionResolved",
              requestId,
              decision: decision.decision,
              scope: decision.scope,
            });
          }
          yield* Deferred.succeed(own.done, decision);
        });

      /** Denies the requests Cerium raised for an agent's tools, once it stopped waiting on them. */
      const releaseOwnRequests = (rt: Runtime, message: string) =>
        Effect.forEach(
          [...ownRequests].filter(([, own]) => own.agentId === rt.info.id),
          ([requestId]) =>
            answerRequest(rt, requestId, { decision: "deny", scope: "once", message }).pipe(Effect.ignore),
          { discard: true },
        );

      /**
       * Hands a child's permission request to its lead, which answers it with `answer_permission`. A
       * lead that isn't running can't, so the request is denied rather than left waiting for good.
       */
      const askLead = (child: Runtime, session: AgentSession, request: PermissionRequest) =>
        Effect.gen(function* () {
          const lead = child.info.parentId === undefined ? undefined : runtimes.get(child.info.parentId);
          if (lead === undefined || lead.ended) {
            return yield* session.respondToPermission(request.requestId, {
              decision: "deny",
              scope: "once",
              message: "Your lead isn't running to approve this, so it was denied.",
            });
          }
          const open = leadRequests.get(child.info.id) ?? new Set<string>();
          leadRequests.set(child.info.id, open.add(request.requestId));
          yield* deliver(lead.info.id, { _tag: "SystemNotice", text: permissionNotice(child.info, request) });
        });

      /** Denies what a lead's children wait on it to answer, once the lead can no longer answer. */
      const releaseLeadRequests = (leadId: AgentId) =>
        Effect.forEach(
          childrenOf(leadId),
          (child) => {
            const waiting = [...(leadRequests.get(child.info.id) ?? [])];
            leadRequests.delete(child.info.id);
            return Effect.forEach(
              waiting,
              (requestId) =>
                answerRequest(child, requestId, {
                  decision: "deny",
                  scope: "once",
                  message: "Your lead stopped before it answered this request, so it was denied.",
                }).pipe(Effect.ignore),
              { discard: true },
            );
          },
          { discard: true },
        );

      const consumeEvents = (rt: Runtime, session: AgentSession) => {
        /**
         * Requests the user never sees, so neither end is recorded: those Cerium approved itself, and a
         * child's, which its lead answers.
         */
        const unseen = new Set<string>();
        return session.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const payload: EventPayload =
                event.payload._tag === "TurnCompleted" &&
                event.payload.stopReason === "interrupted" &&
                rt.steering
                  ? { _tag: "TurnCompleted", stopReason: "steered" }
                  : event.payload;
              if (payload._tag === "PermissionRequested") {
                if (approvesItself(rt.info.access, payload.toolName)) {
                  unseen.add(payload.requestId);
                  return yield* session.respondToPermission(payload.requestId, {
                    decision: "allow",
                    scope: "once",
                  });
                }
                if (rt.info.parentId !== undefined) {
                  unseen.add(payload.requestId);
                  return yield* askLead(rt, session, payload);
                }
              }
              if (payload._tag === "PermissionResolved" && unseen.delete(payload.requestId)) {
                closeLeadRequest(rt.info.id, payload.requestId);
                return;
              }
              yield* emit(rt, payload, event.raw);
              if (
                payload._tag === "AgentError" ||
                (payload._tag === "TurnCompleted" && payload.stopReason === "error")
              ) {
                rt.turnFailed = true;
              }
              if (payload._tag === "FileChanged") rt.turnFiles.add(payload.path);
              if (payload._tag === "ToolCallCompleted" && payload.isError) rt.turnToolErrors += 1;
              if (payload._tag === "TurnCompleted") rt.turnStopReason = payload.stopReason;
              switch (payload._tag) {
                case "SessionStarted": {
                  const updatedAt = yield* Clock.currentTimeMillis;
                  rt.info = { ...rt.info, providerSessionId: payload.providerSessionId, updatedAt };
                  yield* store
                    .updateAgent(rt.info.id, { providerSessionId: payload.providerSessionId, updatedAt })
                    .pipe(Effect.mapError(unavailable));
                  return;
                }
                case "MessageCompleted":
                  rt.lastMessage = payload.text;
                  return;
                case "PermissionRequested": {
                  const pending = pendingPermissions.get(rt.info.id) ?? new Set<string>();
                  pendingPermissions.set(rt.info.id, pending.add(payload.requestId));
                  return;
                }
                case "PermissionResolved":
                  pendingPermissions.get(rt.info.id)?.delete(payload.requestId);
                  return;
                case "ToolCallStarted":
                  rt.openCalls.add(payload.callId);
                  rt.turnToolCalls += 1;
                  return;
                case "ToolCallCompleted":
                  rt.openCalls.delete(payload.callId);
                  // Between steps: the user's waiting messages go now, before the agent's next one.
                  if (rt.openCalls.size === 0) yield* steer(rt);
                  return;
                case "TurnCompleted":
                  rt.openCalls.clear();
                  return yield* finishTurn(rt);
                default:
                  return;
              }
            }),
          ),
          Effect.catchCause((cause) =>
            rt.sleeping
              ? Effect.void
              : Effect.logError(`Agent ${rt.info.id} session failed`, cause).pipe(
                  Effect.annotateLogs({ report: "harness", harness: rt.info.provider, phase: "session" }),
                ),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              if (rt.sleeping) return;
              rt.ended = true;
              yield* expireQuestions(rt).pipe(Effect.ignore);
              yield* releaseOwnRequests(rt, "The agent's session ended before this was answered.");
              if (rt.info.parentId === undefined) yield* releaseLeadRequests(rt.info.id);
              yield* finishTurn(rt);
              if (rt.info.state !== "stopped") yield* setState(rt, "failed").pipe(Effect.ignore);
            }),
          ),
        );
      };

      /** The images and skills a turn's user messages carry, as harnesses take them. */
      const turnExtras = (rt: Runtime, items: ReadonlyArray<InputItem>) =>
        Effect.gen(function* () {
          const fromUser = items.flatMap((item) => (item._tag === "FromUser" ? [item] : []));
          const takesImages = adapters.get(rt.info.provider)?.manifest.input.images === true;
          const read = yield* Effect.forEach(
            takesImages ? fromUser.flatMap((item) => (item.attachments ?? []).filter(isImage)) : [],
            (attachment) =>
              fs.readFile(attachment.path).pipe(
                Effect.map((bytes): TurnImage => ({
                  path: attachment.path,
                  mediaType: attachment.mediaType,
                  data: Base64.encode(bytes),
                })),
                // An image that can't be read any more is still named in the text.
                Effect.option,
              ),
          );
          const images = read.flatMap(Option.toArray);
          const skills = fromUser.flatMap((item) =>
            (item.mentions ?? []).flatMap((mention) =>
              mention._tag === "SkillMention"
                ? [{ name: mention.name, ...(mention.path ? { path: mention.path } : {}) }]
                : [],
            ),
          );
          if (images.length === 0 && skills.length === 0) return undefined;
          return {
            ...(images.length > 0 ? { images } : {}),
            ...(skills.length > 0 ? { skills } : {}),
          } satisfies TurnExtras;
        });

      /** Whether an agent's turns snapshot its thread's folder: it works in one and may change files. */
      const savesFiles = (info: AgentInfo) =>
        threadModes.get(info.threadId) === "work" && info.access !== "readOnly";

      /**
       * A snapshot of the agent's thread's folder now; none when it can't change files or saving failed.
       * With `reuse`, the last one serves when nothing in the folder changed since it was taken.
       */
      const snapshotFor = (info: AgentInfo, reuse = false) => {
        const folder = threadDirectories.get(info.threadId);
        const saved =
          !savesFiles(info) || folder === undefined
            ? Effect.succeedNone
            : checkpoints.save(folder, { reuse }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning(`Couldn't snapshot ${folder}: ${error.message}`),
                ),
                Effect.option,
              );
        return Effect.map(saved, Option.getOrUndefined);
      };

      /** Starts noting what the agent's turn does in its thread's folder, from now. */
      const beginWork = (info: AgentInfo) =>
        Effect.map(Clock.currentTimeMillis, (start) => {
          const folder = threadDirectories.get(info.threadId);
          if (folder === undefined) return;
          activityIn(folder).begin(info.id, start);
          turnsInProgress.set(info.id, { folder, start, commands: [] });
        });

      /** Stops noting what the agent's turn does, and says what it did; nothing when it wasn't noted. */
      const endWork = (agentId: AgentId) =>
        Effect.map(Clock.currentTimeMillis, (end): (TurnWork & { readonly folder: string }) | undefined => {
          const turn = turnsInProgress.get(agentId);
          if (turn === undefined) return undefined;
          turnsInProgress.delete(agentId);
          const activity = activityIn(turn.folder);
          activity.end(agentId, turn.start, end);
          return {
            folder: turn.folder,
            named: activity.namedBy(agentId, turn.start, end, false),
            namedByOthers: activity.namedBy(agentId, turn.start, end, true),
            shared: activity.shared(agentId, turn.start, end),
            commands: turn.commands,
          };
        });

      /** Records the files a turn changed, from its snapshots before and after, for its summary. */
      const reportTurnFiles = (
        rt: Runtime,
        turnId: string,
        before: string,
        after: string,
        work: TurnWork & { readonly folder: string },
      ) =>
        Effect.gen(function* () {
          if (before === after) return;
          const differing = yield* checkpoints.changes(work.folder, before, after);
          if (differing.length === 0) return;
          const lines = yield* checkpoints.lines(work.folder, before, after);
          const { files, more } = turnFiles(differing, lines, work);
          const [first, ...rest] = files;
          if (first === undefined) return;
          yield* emit(rt, {
            _tag: "TurnFilesChanged",
            turnId,
            before,
            after,
            files: [first, ...rest],
            ...(more > 0 ? { more } : {}),
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(`Couldn't list the files turn ${turnId} changed: ${error.message}`),
          ),
        );

      const runTurn = (
        rt: Runtime,
        session: AgentSession,
        items: readonly [InputItem, ...Array<InputItem>],
      ) =>
        Effect.gen(function* () {
          yield* setState(rt, "running");
          rt.lastMessage = undefined;
          rt.halted = false;
          rt.steering = false;
          rt.openCalls.clear();
          rt.turnToolCalls = 0;
          rt.turnFailed = false;
          rt.turnToolErrors = 0;
          rt.turnStopReason = undefined;
          rt.turnFiles.clear();
          const startedAt = yield* Clock.currentTimeMillis;
          rt.turn = yield* Deferred.make<void>();
          const turnId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          // The folder as it was before the turn, which restoring to before its messages goes back to:
          // usually as the last turn left it, so that snapshot serves and the turn starts at once.
          const files = yield* snapshotFor(rt.info, true);
          if (files !== undefined) yield* beginWork(rt.info);
          yield* emit(rt, { _tag: "TurnInput", items, turnId, ...(files === undefined ? {} : { files }) });
          const extras = yield* turnExtras(rt, items);
          yield* session.send(renderTurn(items), { ...extras, turnId }).pipe(
            // A turn the harness refused never ends on its own, leaving the agent working with
            // nothing to stop; it ends here with the reason.
            Effect.catch((error) =>
              Effect.gen(function* () {
                rt.turnFailed = true;
                yield* emit(rt, {
                  _tag: "AgentError",
                  kind: "unknown",
                  message: error.message,
                  retryable: false,
                });
                yield* emit(rt, { _tag: "TurnCompleted", stopReason: "error" });
                yield* finishTurn(rt);
              }),
            ),
          );
          // A stopped agent's turn ends here too, so it isn't counted as working in the folder for good.
          yield* Deferred.await(rt.turn).pipe(Effect.onInterrupt(() => Effect.asVoid(endWork(rt.info.id))));
          rt.turn = undefined;
          // What the effort router reads before the next turn.
          rt.fresh = false;
          rt.lastTurn = {
            toolCalls: rt.turnToolCalls,
            seconds: Math.round(((yield* Clock.currentTimeMillis) - startedAt) / 1000),
            failed: rt.turnFailed,
            filesChanged: rt.turnFiles.size,
            toolErrors: rt.turnToolErrors,
            ...(rt.turnStopReason === undefined ? {} : { stopReason: rt.turnStopReason }),
          };
          rt.recent?.push({ sent: renderTurn(items), replied: rt.lastMessage ?? "" });
          rt.recent?.splice(0, Math.max(0, rt.recent.length - RECENT_EXCHANGES));
          const work = yield* endWork(rt.info.id);
          // And as it was after, so a restore can tell the files this turn changed from another thread's,
          // and the turn's summary which files it changed: saved behind the turn, so the agent is free at once.
          if (files !== undefined) {
            yield* Effect.forkIn(
              snapshotFor(rt.info).pipe(
                Effect.flatMap((after) =>
                  after === undefined
                    ? Effect.void
                    : emit(rt, { _tag: "FilesSaved", snapshot: after, turnId }).pipe(
                        Effect.andThen(
                          work === undefined ? Effect.void : reportTurnFiles(rt, turnId, files, after, work),
                        ),
                      ),
                ),
                Effect.ignore,
              ),
              rt.scope,
            );
          }
        });

      /**
       * A compaction the user asked for: a turn with no input, which the harness's own events report and
       * end. The agent's lead hears nothing of it, as it delivered nothing.
       */
      const compactTurn = (rt: Runtime, compact: Effect.Effect<void, HarnessFailure>) =>
        Effect.gen(function* () {
          if (rt.ended) return;
          yield* setState(rt, "running");
          rt.halted = false;
          rt.steering = false;
          rt.openCalls.clear();
          rt.turn = yield* Deferred.make<void>();
          yield* compact.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* emit(rt, {
                  _tag: "AgentError",
                  kind: "unknown",
                  message: `Couldn't compact the conversation: ${error.message}`,
                  retryable: false,
                });
                yield* emit(rt, { _tag: "TurnCompleted", stopReason: "error" });
                yield* finishTurn(rt);
              }),
            ),
          );
          yield* Deferred.await(rt.turn);
          rt.turn = undefined;
          // A message that arrived meanwhile has the agent queued for its turn already.
          if (!rt.ended && rt.info.state === "running") yield* setState(rt, "idle");
        }).pipe(
          Effect.catchCause((cause) => Effect.logError(`Agent ${rt.info.id} compaction failed`, cause)),
        );

      /**
       * Switches the session to the model, effort and speed the user picked since its last turn. When
       * the harness refuses, the thread says why and the agent goes back to what its session runs.
       */
      const applyModel = (rt: Runtime, session: AgentSession) =>
        Effect.gen(function* () {
          // On Auto, the level the router set for this turn stands in for the one picked.
          const wantedOf = (): ModelChoice => ({
            ...choiceOf(rt.info),
            ...(rt.routedEffort === undefined ? {} : { effort: rt.routedEffort }),
          });
          const wanted = wantedOf();
          const switched = Effect.gen(function* () {
            if (wanted.model !== rt.applied.model) {
              yield* session
                .setModel(wanted.model)
                .pipe(Effect.mapError((error) => `Couldn't switch to ${wanted.model}: ${error.message}`));
              rt.applied = { ...rt.applied, model: wanted.model };
            }
            if (wanted.effort !== undefined && wanted.effort !== rt.applied.effort) {
              const effort = wanted.effort;
              yield* session
                .setEffort(effort)
                .pipe(
                  Effect.mapError((error) => `Couldn't change the effort to ${effort}: ${error.message}`),
                );
              rt.applied = { ...rt.applied, effort };
            }
            if (wanted.speed !== undefined && wanted.speed !== rt.applied.speed && session.setSpeed) {
              const speed = wanted.speed;
              yield* session
                .setSpeed(speed)
                .pipe(Effect.mapError((error) => `Couldn't change the speed to ${speed}: ${error.message}`));
              rt.applied = { ...rt.applied, speed };
            }
          });
          yield* switched.pipe(
            Effect.catch((message) =>
              Effect.gen(function* () {
                yield* emit(rt, { _tag: "AgentError", kind: "unknown", message, retryable: false });
                // A pick made while this one was being applied stands, for the next turn to try.
                const now = wantedOf();
                if (
                  now.model === wanted.model &&
                  now.effort === wanted.effort &&
                  now.speed === wanted.speed
                ) {
                  yield* recordModel(rt.info, rt, {
                    ...rt.applied,
                    // A level the router set was never the user's pick, which stays as it was.
                    ...(rt.routedEffort !== undefined && rt.info.effort !== undefined
                      ? { effort: rt.info.effort }
                      : {}),
                    ...(rt.info.autoEffort ? { autoEffort: true } : {}),
                  });
                }
              }),
            ),
            // The turn goes ahead on what the session runs, whatever became of the switch: its
            // messages are already out of the inbox.
            Effect.catch((error) => Effect.logWarning(`Couldn't record a refused switch: ${error.message}`)),
          );
        });

      /** The agent's last exchanges, read from its stored events the first time the router needs them. */
      const recentOf = (rt: Runtime) =>
        Effect.gen(function* () {
          if (rt.recent !== undefined) return rt.recent;
          const events = yield* store
            .listEvents(rt.info.id, {
              tags: ["TurnInput", "MessageCompleted", "TurnCompleted", "ConversationRewound"],
            })
            .pipe(Effect.orElseSucceed(() => []));
          const recent: Array<Exchange> = [];
          let sent: string | undefined;
          let replied = "";
          for (const { payload } of events) {
            if (payload._tag === "TurnInput") {
              sent = renderTurn(payload.items);
              replied = "";
            } else if (payload._tag === "MessageCompleted") {
              replied = payload.text;
            } else if (payload._tag === "TurnCompleted" && sent !== undefined) {
              recent.push({ sent, replied });
              sent = undefined;
            } else if (payload._tag === "ConversationRewound") {
              recent.length = 0;
            }
          }
          rt.recent = recent.slice(-RECENT_EXCHANGES);
          return rt.recent;
        });

      /**
       * On an agent set to Auto, the effort router picks the effort of the turn about to start, and
       * the thread records what it decided. A model that starts its prompt cache over when effort
       * changes is routed only on a new session's first turn. The level picked for the agent is the
       * one it falls back to where the decision model can't decide; the router's levels hold for its
       * session only. Whatever else goes wrong, the turn runs at the picked level and goes ahead.
       */
      const routeEffort = (rt: Runtime, items: readonly [InputItem, ...Array<InputItem>]) =>
        Effect.gen(function* () {
          rt.effortDecision = undefined;
          rt.routedEffort = undefined;
          if (rt.info.autoEffort !== true || !(yield* routerOn)) return;
          const models = yield* (catalog.models ?? Effect.succeed([])).pipe(
            Effect.timeoutOption("3 seconds"),
            Effect.map(Option.getOrElse((): ReadonlyArray<ModelInfo> => [])),
          );
          const model = models.find(
            (each) => each.provider === rt.info.provider && each.id === rt.info.model,
          );
          const [lowest, ...higher] = model?.efforts ?? [];
          // Nothing to pick between.
          if (model === undefined || lowest === undefined || higher.length === 0) return;
          const levels = [lowest, ...higher] as const;
          // The level its session runs at: the last turn's.
          const current = rt.applied.effort ?? rt.info.effort ?? model.defaultEffort;
          // Where the router can't decide, the turn runs at the level picked for the agent, as near as
          // the model has.
          const fallback = supportedLevel(levels, rt.info.effort ?? model.defaultEffort ?? "high");
          /** The turn runs at `effort`, for this turn only; the picked level stays as it is. */
          const runAt = (effort: ReasoningEffort, decision: Omit<EffortRouted, "_tag" | "effort">) =>
            Effect.sync(() => {
              rt.routedEffort = effort;
              rt.effortDecision = { _tag: "EffortRouted", effort, ...decision };
            });
          const fallBack = (kept: "timeout" | "failed", extra: Partial<EffortRouted>) =>
            runAt(fallback, { kept, baselineEffort: fallback, ...extra });
          if (model.cacheSafeEffort !== true && !rt.fresh) {
            if (current !== undefined && levels.includes(current)) rt.routedEffort = current;
            rt.effortDecision = {
              _tag: "EffortRouted",
              ...(current ? { effort: current } : {}),
              kept: "cache",
            };
            return;
          }

          const history = yield* store.listEvents(rt.info.id, {
            tags: ["TurnInput", "TodosUpdated", "ConversationRewound"],
          });
          let task = "";
          let latestRequest = "";
          let pending: string[] = [];
          for (const { payload } of history) {
            if (payload._tag === "ConversationRewound") {
              task = "";
              latestRequest = "";
              pending = [];
            }
            if (payload._tag === "TurnInput")
              for (const item of payload.items) {
                if (item._tag === "FromUser") {
                  if (!task) task = item.text;
                  if (item.text.length >= 80) latestRequest = item.text;
                }
              }
            if (payload._tag === "TodosUpdated")
              pending = payload.items
                .filter((item) => item.status === "pending" || item.status === "inProgress")
                .slice(0, 12)
                .map((item) => clipContext(item.text, 200));
          }
          if (rt.lastTurn === undefined) {
            const lastInput = history.findLast((event) => event.payload._tag === "TurnInput");
            if (lastInput) {
              const facts = yield* store.listEvents(rt.info.id, {
                afterSequence: lastInput.sequence,
                tags: ["ToolCallStarted", "ToolCallCompleted", "FileChanged", "AgentError", "TurnCompleted"],
              });
              rt.lastTurn = {
                toolCalls: facts.filter((event) => event.payload._tag === "ToolCallStarted").length,
                toolErrors: facts.filter(
                  (event) => event.payload._tag === "ToolCallCompleted" && event.payload.isError,
                ).length,
                seconds: Math.max(0, Math.round(((facts.at(-1)?.at ?? lastInput.at) - lastInput.at) / 1000)),
                filesChanged: new Set(
                  facts.flatMap((event) =>
                    event.payload._tag === "FileChanged" ? [event.payload.path] : [],
                  ),
                ).size,
                failed: facts.some(
                  (event) =>
                    event.payload._tag === "AgentError" ||
                    (event.payload._tag === "TurnCompleted" && event.payload.stopReason === "error"),
                ),
                stopReason:
                  facts
                    .flatMap((event) =>
                      event.payload._tag === "TurnCompleted" ? [event.payload.stopReason] : [],
                    )
                    .at(-1) ?? "interrupted",
              };
            }
          }
          const state = {
            // The first request anchors approvals; pending items carry the current scope.
            ...effortState(
              {
                from: items.some((item) => item._tag === "FromUser") ? "user" : "agent",
                text: renderTurn(items),
              },
              yield* recentOf(rt),
              rt.lastTurn,
            ),
            task: clipContext(task === latestRequest ? task : `${task}\n${latestRequest}`, 2000),
            pending,
            model: { provider: rt.info.provider, id: rt.info.model },
          };
          const question = { levels, state };
          const startedAt = yield* Clock.currentTimeMillis;
          const asked = yield* decider
            .decide(question)
            .pipe(Effect.timeoutOption(DECISION_TIMEOUT), Effect.result);
          const ms = (yield* Clock.currentTimeMillis) - startedAt;
          if (Result.isFailure(asked))
            return yield* fallBack("failed", { ms, detail: asked.failure.message });
          if (Option.isNone(asked.success)) return yield* fallBack("timeout", { ms });
          const answer = asked.success.value;
          const cost = answer.costUsd === undefined ? {} : { costUsd: answer.costUsd };
          const top = likeliest(levels, answer.probabilities);
          if (top === undefined || !validProbabilities(answer.probabilities, levels.length))
            return yield* fallBack("failed", {
              ms,
              ...cost,
              detail: "The answer contained invalid probabilities.",
            });
          const selected = selectEffort(question, answer, current, fallback);
          yield* runAt(selected.effort, {
            policyVersion: POLICY_VERSION,
            ...(selected.kept === undefined ? {} : { kept: selected.kept }),
            proposedEffort: top,
            baselineEffort: fallback,
            question,
            levels: [...levels],
            probabilities: [...answer.probabilities],
            ...(current ? { beforeEffort: current } : {}),
            ...(answer.decisionModel ? { decisionModel: answer.decisionModel } : {}),
            ...(answer.taskType ? { taskType: answer.taskType } : {}),
            ...(answer.contextSufficient === undefined
              ? {}
              : { contextSufficient: answer.contextSufficient }),
            ms,
            confidence: Math.min(1, Math.max(0, answer.confidence)),
            ...cost,
          });
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`Couldn't route ${rt.info.id}'s effort`, cause)),
        );

      /**
       * The brief a lead handed to another harness owes its new session with its first turn: the
       * conversation so far, its older turns condensed by the quick model. None once told.
       */
      const briefFor = (rt: Runtime) =>
        Effect.gen(function* () {
          const handoff = briefsOwed.get(rt.info.id);
          if (handoff === undefined) return undefined;
          briefsOwed.delete(rt.info.id);
          const history = liveEvents(
            yield* store.listEvents(rt.info.id, { tags: BRIEF_TAGS }).pipe(Effect.mapError(unavailable)),
          );
          const summary = yield* condenser.condense(olderTurns(history), {
            provider: rt.info.provider,
            model: rt.info.model,
          });
          const running = childrenOf(rt.info.id)
            .filter((child) => !child.ended && !isHelper(child.info))
            .map((child) => child.info);
          const item: InputItem = {
            _tag: "SystemNotice",
            text: handoffBrief(history, {
              from: handoff.from,
              summary: Option.getOrUndefined(summary),
              running,
            }),
          };
          return item;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning(`Couldn't brief ${rt.info.id} on its conversation`, cause),
              undefined,
            ),
          ),
        );

      /**
       * Delivers inbox items as turns, one turn at a time. Agents never wait for one another's turns
       * to end: a cap on turns at once would leave a messaged thread queued behind other threads' long
       * turns, or behind a child's turn waiting on an answer from the very lead that is queued.
       */
      const turnLoop = (rt: Runtime) =>
        Effect.gen(function* () {
          const first = yield* Queue.take(rt.inbox);
          // An advisor answers one question a turn, each to the agent that asked it; a reviewer reviews
          // the one diff it was started with.
          const advisor = isHelper(rt.info);
          // Notices wait briefly so several arriving together become one turn; the user never waits.
          if (first._tag !== "FromUser" && !advisor) yield* Effect.sleep(config.batchWindow);
          const items = advisor
            ? ([first] as const)
            : withHeld(rt.info.id, [first, ...(yield* Queue.clear(rt.inbox))]);
          if (!advisor) rt.userWaiting = false;
          if (rt.ended) return yield* Effect.interrupt;

          yield* setState(rt, "queued");
          rt.touchedAt = Date.now();
          yield* rt.wakeSession;
          // A session that never started took nothing: what the user sent waits for the next start.
          // The effort router decides meanwhile, so a starting session doesn't wait on it as well, and
          // a lead just handed to this harness has its brief written.
          const [session, , brief] = yield* Effect.all(
            [
              Deferred.await(rt.started).pipe(Effect.tapError(() => setState(rt, "failed"))),
              routeEffort(rt, items),
              briefFor(rt),
            ],
            { concurrency: 3 },
          );
          const told: readonly [InputItem, ...Array<InputItem>] =
            brief === undefined ? items : [brief, ...items];
          yield* rt.turnPermit.withPermits(1)(
            Effect.gen(function* () {
              yield* applyModel(rt, session);
              if (rt.effortDecision) {
                const { effort: requested, ...decision } = rt.effortDecision;
                const actual = rt.applied.effort;
                yield* emit(rt, {
                  ...decision,
                  ...(actual ? { effort: actual } : {}),
                  ...(requested !== actual ? { detail: "The harness kept its previous effort." } : {}),
                });
              }
              yield* runTurn(rt, session, told);
            }),
          );
          if (rt.ended) return yield* Effect.interrupt;
          yield* setState(rt, "idle");
          rt.touchedAt = Date.now();
          const halted = rt.halted;
          rt.halted = false;

          const review = reviews.get(rt.info.id);
          if (review !== undefined) {
            reviews.delete(rt.info.id);
            yield* halted
              ? Deferred.fail(
                  review,
                  new OrchestratorError({ reason: "unavailable", message: "The review was stopped." }),
                )
              : Deferred.succeed(review, rt.lastMessage ?? "");
            // Its answer is all it was for; stopped behind this fiber, which stopping interrupts.
            yield* Effect.forkIn(stopRuntime(rt), layerScope);
          } else if (advisor) {
            if (first._tag !== "FromAgent") return;
            const waiting = advisorQuestions.get(rt.info.id) ?? [];
            const index = waiting.indexOf(first.agentId);
            if (index !== -1) waiting.splice(index, 1);
            // The asker was stopped with it: a cut-off answer would only wake it again.
            if (halted) return;
            yield* deliver(first.agentId, {
              _tag: "FromAgent",
              agentId: rt.info.id,
              threadId: rt.info.threadId,
              text: truncate(rt.lastMessage ?? "(no answer)", config.maxDeliveredChars),
            });
          } else if (rt.info.parentId !== undefined && !halted) {
            yield* deliver(rt.info.parentId, {
              _tag: "ChildFinishedTurn",
              agentId: rt.info.id,
              role: rt.info.role,
              text: truncate(rt.lastMessage ?? "(no final message)", config.maxDeliveredChars),
            });
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logError(`Agent ${rt.info.id} turn failed`, cause)),
          Effect.forever,
        );

      /**
       * The other work threads whose leads are live in a lead's folder, for its prompt: their agents may
       * be changing the same files.
       */
      const neighboursOf = (info: AgentInfo, cwd: string) =>
        Effect.gen(function* () {
          if (info.parentId !== undefined || threadModes.get(info.threadId) !== "work") return [];
          const live = [...runtimes.values()].filter((rt) => {
            const folder = threadDirectories.get(rt.info.threadId);
            return (
              rt.info.parentId === undefined &&
              rt.info.threadId !== info.threadId &&
              !rt.ended &&
              threadModes.get(rt.info.threadId) === "work" &&
              folder !== undefined &&
              path.relative(folder, cwd) === ""
            );
          });
          if (live.length === 0) return [];
          const threads = yield* store.listThreads.pipe(Effect.orElseSucceed(() => []));
          return live.flatMap((rt): ReadonlyArray<Neighbour> => {
            const thread = threads.find((candidate) => candidate.id === rt.info.threadId);
            return thread === undefined || thread.archivedAt !== undefined
              ? []
              : [{ title: thread.title, leadId: rt.info.id, model: rt.info.model, state: rt.info.state }];
          });
        });

      /**
       * Makes an agent live at once, so it takes messages straight away; its harness session starts
       * behind it, and a failure to start is told in its transcript.
       */
      const startRuntime = (
        info: AgentInfo,
        cwd: string,
        options: { readonly initial?: InputItem; readonly resume?: string } = {},
      ) =>
        Effect.gen(function* () {
          const adapter = adapters.get(info.provider);
          if (adapter === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${info.provider} adapter is installed.`,
            });
          }
          const last = yield* store.lastSequence(info.id).pipe(Effect.mapError(unavailable));
          const scope = yield* Scope.fork(agentsScope);
          const rt: Runtime = {
            info,
            session: undefined,
            started: yield* Deferred.make<AgentSession, OrchestratorError>(),
            sessionScope: undefined,
            sessionPermit: yield* Semaphore.make(1),
            sleeping: false,
            touchedAt: Date.now(),
            wakeSession: Effect.void,
            inbox: yield* Queue.unbounded<InputItem>(),
            scope,
            sequence: Option.match(last, { onNone: () => 0, onSome: (sequence) => sequence + 1 }),
            turn: undefined,
            turnPermit: yield* Semaphore.make(1),
            lastMessage: undefined,
            ended: false,
            halted: false,
            userWaiting: false,
            openCalls: new Set(),
            steering: false,
            applied: choiceOf(info),
            fresh: options.resume === undefined,
            recent: undefined,
            lastTurn: undefined,
            turnToolCalls: 0,
            turnFailed: false,
            turnToolErrors: 0,
            turnStopReason: undefined,
            effortDecision: undefined,
            routedEffort: undefined,
            turnFiles: new Set(),
            storedRaw: undefined,
          };
          runtimes.set(info.id, rt);

          let resume = options.resume;
          const start = Effect.gen(function* () {
            const info = rt.info;
            const sessionScope = yield* Scope.fork(scope);
            rt.sessionScope = sessionScope;
            const { includeUserMcpServers, advisor } = yield* settings.get;
            const neighbours = yield* neighboursOf(info, cwd);
            const busSpec = yield* bus.register(info.id);
            yield* Scope.addFinalizer(sessionScope, bus.unregister(info.id));
            const session = yield* adapter
              .startSession({
                cwd,
                model: info.model,
                ...(info.effort ? { effort: info.effort } : {}),
                ...(info.speed ? { speed: info.speed } : {}),
                ...(resume === undefined ? {} : { resume }),
                access: info.access,
                mcpServers: { [bus.serverName]: busSpec },
                includeUserMcpServers,
                trustedMcpServers: [bus.serverName],
                appendSystemPrompt: systemPrompt(info, bus.serverName, {
                  advisor: advisor.enabled && advisor.model !== undefined,
                  neighbours,
                  worktree: threadWorktrees.get(info.threadId),
                }),
              })
              .pipe(
                Scope.provide(sessionScope),
                // A harness that isn't installed or signed in is the user's to fix; anything else is
                // reported (apps/backend/src/reports.ts).
                Effect.tapError((error) =>
                  error._tag === "HarnessUnavailable"
                    ? Effect.void
                    : Effect.logError("Harness session failed to start", Cause.fail(error)).pipe(
                        Effect.annotateLogs({ report: "harness", harness: info.provider, phase: "start" }),
                      ),
                ),
                Effect.mapError(
                  (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
                ),
              );
            rt.session = session;
            yield* Effect.forkIn(consumeEvents(rt, session), sessionScope);
            yield* Deferred.succeed(rt.started, session);
          });
          rt.wakeSession = rt.sessionPermit.withPermits(1)(
            Effect.gen(function* () {
              rt.touchedAt = Date.now();
              if (!rt.sleeping || rt.ended) return;
              rt.sleeping = false;
              rt.started = yield* Deferred.make<AgentSession, OrchestratorError>();
              resume = rt.info.providerSessionId;
              yield* start.pipe(
                Effect.catch((error) => Deferred.fail(rt.started, error)),
                Effect.asVoid,
              );
            }),
          );
          yield* Effect.forkIn(
            start.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  rt.ended = true;
                  yield* emit(rt, {
                    _tag: "AgentError",
                    kind: "unknown",
                    message: error.message,
                    retryable: false,
                  });
                  yield* setState(rt, "failed");
                }).pipe(Effect.ensuring(Deferred.fail(rt.started, error)), Effect.ignore),
              ),
            ),
            scope,
          );
          // A folder's first snapshot reads every file in it; taken now, the first turn's is quick.
          if (savesFiles(info)) yield* Effect.forkIn(snapshotFor(info), scope);
          yield* Effect.forkIn(turnLoop(rt), scope);
          if (options.initial !== undefined) yield* Queue.offer(rt.inbox, options.initial);
          return rt;
        });

      const now = Clock.currentTimeMillis;

      const awaitingApproval = (threadId: ThreadId) =>
        [...runtimes.values()].some(
          (rt) => rt.info.threadId === threadId && (pendingPermissions.get(rt.info.id)?.size ?? 0) > 0,
        );

      /** A question an agent of the thread asked is waiting on the user. */
      const asking = (threadId: ThreadId) =>
        [...runtimes.values()].some(
          (rt) => rt.info.threadId === threadId && (openQuestions.get(rt.info.id)?.size ?? 0) > 0,
        );

      /**
       * A permission request, a question, or a lead's request to start an agent outside the catalog waits
       * on the user.
       */
      const waitsOnUser = (threadId: ThreadId) =>
        awaitingApproval(threadId) ||
        asking(threadId) ||
        [...pendingSpawns.values()].some(({ leadId }) => runtimes.get(leadId)?.info.threadId === threadId);

      const working = (threadId: ThreadId) =>
        [...runtimes.values()].some(
          (rt) =>
            rt.info.threadId === threadId && (rt.info.state === "running" || rt.info.state === "queued"),
        );

      /** Applies a change to a stored thread; renaming and archiving don't count as activity. */
      const updateThread = (threadId: ThreadId, patch: ThreadPatch) =>
        Effect.gen(function* () {
          yield* store.updateThread(threadId, patch).pipe(Effect.mapError(unavailable));
          const thread = Option.getOrUndefined(
            yield* store.getThread(threadId).pipe(Effect.mapError(unavailable)),
          );
          if (thread === undefined) return yield* notFound(`Thread ${threadId} does not exist.`);
          return thread;
        });

      /** A child never gets more access than its lead, and only reads in a chat. */
      const childAccess = (lead: Runtime, request: SpawnRequest): AccessMode =>
        (threadModes.get(lead.info.threadId) ?? "work") === "chat"
          ? "readOnly"
          : narrowAccess(lead.info.access, request.access ?? lead.info.access);

      const launchChild = (lead: Runtime, request: SpawnRequest, target: SpawnTarget) =>
        Effect.gen(function* () {
          const createdAt = yield* now;
          // A child of an Auto lead spawned without an effort is routed too, or runs at its lead's
          // level, as the user chose.
          const { children } = (yield* settings.get).effortRouter;
          const follows = request.effort === undefined && lead.info.autoEffort === true && (yield* routerOn);
          const autoEffort = follows && children === "router";
          const effort =
            follows && children === "lead"
              ? (lead.routedEffort ?? lead.info.effort ?? target.effort)
              : target.effort;
          const child: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId: lead.info.threadId,
            parentId: lead.info.id,
            role: request.role,
            provider: target.provider,
            model: target.model,
            ...(effort ? { effort } : {}),
            ...(autoEffort ? { autoEffort: true } : {}),
            ...(target.speed ? { speed: target.speed } : {}),
            access: childAccess(lead, request),
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createAgent(child).pipe(Effect.mapError(unavailable));
          yield* emit(lead, {
            _tag: "AgentSpawned",
            childId: child.id,
            role: child.role,
            provider: child.provider,
            model: child.model,
            access: child.access,
          });
          const cwd = threadDirectories.get(lead.info.threadId) ?? ".";
          yield* startRuntime(child, cwd, {
            initial: {
              _tag: "FromAgent",
              agentId: lead.info.id,
              threadId: lead.info.threadId,
              text: request.prompt,
            },
          });
          return child.id;
        });

      /**
       * The thread's advisor, started as a read-only child of its lead when none runs. A new pick in
       * settings takes over once the running advisor has answered what it was asked.
       */
      const advisorFor = (asker: Runtime, chosen: NonNullable<AdvisorSettings["model"]>) =>
        Effect.gen(function* () {
          const { threadId } = asker.info;
          const live = advisors.get(threadId);
          if (live !== undefined && !live.ended) {
            const picked =
              live.info.provider === chosen.provider &&
              live.info.model === chosen.model &&
              live.info.effort === chosen.effort;
            if (picked || (advisorQuestions.get(live.info.id)?.length ?? 0) > 0) return live;
            yield* stopRuntime(live);
          }
          const leadId = asker.info.parentId ?? asker.info.id;
          const createdAt = yield* now;
          const info: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId,
            parentId: leadId,
            role: ADVISOR_ROLE,
            provider: chosen.provider,
            model: chosen.model,
            ...(chosen.effort ? { effort: chosen.effort } : {}),
            access: "readOnly",
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createAgent(info).pipe(Effect.mapError(unavailable));
          const lead = runtimes.get(leadId);
          if (lead !== undefined) {
            yield* emit(lead, {
              _tag: "AgentSpawned",
              childId: info.id,
              role: info.role,
              provider: info.provider,
              model: info.model,
              access: info.access,
            });
          }
          const rt = yield* startRuntime(info, threadDirectories.get(threadId) ?? ".");
          advisors.set(threadId, rt);
          return rt;
        });

      /** Counts one more use of `key` against `budget`, refused with `refusal` of the recent count once spent. */
      const spend = (
        key: string,
        budget: OrchestratorSettings["messageBudget"],
        refusal: (recent: number) => string,
      ) =>
        Effect.gen(function* () {
          const sentAt = yield* now;
          const windowStart = sentAt - Duration.toMillis(budget.window);
          const recent = (sentMessages.get(key) ?? []).filter((time) => time > windowStart);
          if (recent.length >= budget.limit) {
            return yield* new OrchestratorError({
              reason: "budgetExceeded",
              message: refusal(recent.length),
            });
          }
          sentMessages.set(key, [...recent, sentAt]);
        });

      /** Counts one more message from `key`'s sender against the per-pair budget. */
      const spendBudget = (key: string, to: string) =>
        spend(
          key,
          config.messageBudget,
          (recent) =>
            `You have sent ${recent} messages to ${to} recently, the most allowed. Finish your task or wait.`,
        );

      const resolveTarget = (
        entries: ReadonlyArray<CatalogEntry>,
        request: Pick<SpawnRequest, "model" | "provider" | "effort">,
      ): SpawnTarget | undefined => {
        const entry =
          entries.find((candidate) => candidate.alias === request.model) ??
          entries.find(
            (candidate) =>
              candidate.model === request.model &&
              (request.provider === undefined || candidate.provider === request.provider),
          );
        if (entry === undefined) return undefined;
        const effort = request.effort ?? entry.effort;
        return {
          provider: entry.provider,
          model: entry.model,
          ...(effort ? { effort } : {}),
          ...(entry.speed ? { speed: entry.speed } : {}),
        };
      };

      const stopRuntime = (rt: Runtime) =>
        Effect.gen(function* () {
          yield* expireQuestions(rt).pipe(Effect.ignore);
          runtimes.delete(rt.info.id);
          pendingPermissions.delete(rt.info.id);
          leadRequests.delete(rt.info.id);
          // A resumed session finds what it hadn't heard in the thread's history.
          heldNotices.delete(rt.info.id);
          awaitedReplies.delete(rt.info.id);
          yield* setState(rt, "stopped").pipe(Effect.ignore);
          rt.ended = true;
          yield* Scope.close(rt.scope, Exit.void);
        });

      const threadInfo = (threadId: ThreadId) =>
        store.getThread(threadId).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(notFound(`Thread ${threadId} does not exist.`)),
              onSome: Effect.succeed,
            }),
          ),
        );

      /**
       * Removes a thread's worktree once its sessions have ended: a harness still running in the folder
       * would hold it open. Refused while the worktree holds work its base doesn't, unless the user
       * chose to discard it.
       */
      const removeWorktree = Effect.fn("Orchestrator.removeWorktree")(function* (
        threadId: ThreadId,
        worktree: ThreadWorktree,
        options: PutAwayOptions,
      ) {
        if (options.discardWork !== true) {
          const changes = yield* worktrees.changes(worktree).pipe(Effect.mapError(refusedWorktree));
          if (changes.uncommitted > 0 || changes.unmerged > 0) {
            return yield* notAllowed(
              `This thread's worktree has ${describeChanges(changes, worktree.base)}; confirm to put it away.`,
            );
          }
        }
        yield* Effect.forEach(
          [...runtimes.values()].filter((rt) => rt.info.threadId === threadId),
          stopRuntime,
          { discard: true },
        );
        yield* worktrees.remove(threadId, worktree).pipe(Effect.mapError(refusedWorktree));
        threadWorktrees.delete(threadId);
      });

      /** The folder a thread's agents run in: the work thread's own, or a chat's private one. */
      const threadDirectory = (thread: ThreadInfo) =>
        thread.mode === "work" && thread.cwd !== undefined
          ? thread.cwd
          : path.join(config.chatDirectory, thread.id);

      /**
       * Starts a stopped or failed lead again on its harness session, so the thread carries on with
       * the context it had; a lead whose session never started gets a new one, as does one a rewind
       * left without a session. Returns the user's messages the old runtime never delivered (after
       * the conversation a replaying rewind tells), and notices the lead's next turn should carry.
       */
      const resumeLead = Effect.fn("Orchestrator.resumeLead")(function* (agentId: AgentId) {
        const previous = runtimes.get(agentId);
        const info =
          previous?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (info.parentId !== undefined) {
          return yield* notAllowed(`${info.model} has stopped; only a thread's lead can be resumed.`);
        }
        const adapter = adapters.get(info.provider);
        if (
          info.providerSessionId !== undefined &&
          adapter !== undefined &&
          !adapter.manifest.session.resume
        ) {
          return yield* new OrchestratorError({
            reason: "unavailable",
            message: `${info.provider} sessions can't be resumed.`,
          });
        }
        const thread = Option.getOrUndefined(
          yield* store.getThread(info.threadId).pipe(Effect.mapError(unavailable)),
        );
        if (thread === undefined) return yield* notFound(`Thread ${info.threadId} does not exist.`);
        if (thread.worktree !== undefined && thread.archivedAt !== undefined) {
          return yield* notAllowed(
            "This thread's worktree was removed when it was archived; restore it first.",
          );
        }
        const directory = threadDirectory(thread);
        threadDirectories.set(thread.id, directory);
        threadModes.set(thread.id, thread.mode);
        if (thread.worktree !== undefined) threadWorktrees.set(thread.id, thread.worktree);

        // A failed lead still holds its ended session and bus registration; release them first.
        if (previous !== undefined) {
          runtimes.delete(agentId);
          yield* Scope.close(previous.scope, Exit.void);
        }
        pendingPermissions.delete(agentId);
        openQuestions.delete(agentId);
        // A failed session's held notices come back from its history below.
        heldNotices.delete(agentId);
        // What rewinds replaced is no longer the conversation the session goes on from.
        const history = liveEvents(
          yield* store.listEvents(agentId, { tags: RESUME_TAGS }).pipe(Effect.mapError(unavailable)),
        );
        // Approvals and questions the old session was waiting on died with it, and so did its requests to
        // start agents (which a restart of Cerium has forgotten anyway); messages it never took go to the
        // new one.
        const unanswered = new Set<string>();
        const unansweredSpawns = new Map<string, string>();
        const undelivered = new Map<string, InputItem>();
        // Questions still open are closed now; those closed as expired since the agent's last turn are
        // ones it never heard the end of.
        // Dismissals since then are notices it was still to hear with its next turn.
        const askedQuestions = new Map<string, OpenQuestion>();
        const unansweredQuestions = new Set<string>();
        const expiredAt = new Map<string, number>();
        const dismissedAt = new Map<string, number>();
        // Other threads' heads-ups no turn has delivered yet still wait for its next one.
        const heldMessages = new Map<string, FromAgent>();
        let lastTurnAt = -1;
        for (const [index, { payload }] of history.entries()) {
          if (payload._tag === "PermissionRequested") unanswered.add(payload.requestId);
          if (payload._tag === "PermissionResolved") unanswered.delete(payload.requestId);
          if (payload._tag === "QuestionAsked") {
            askedQuestions.set(payload.requestId, payload.questions);
            unansweredQuestions.add(payload.requestId);
          }
          if (payload._tag === "QuestionResolved") {
            unansweredQuestions.delete(payload.requestId);
            if (payload.outcome === "expired") expiredAt.set(payload.requestId, index);
            if (payload.outcome === "dismissed") dismissedAt.set(payload.requestId, index);
          }
          if (payload._tag === "TurnInput") lastTurnAt = index;
          if (payload._tag === "SpawnApprovalRequested") {
            unansweredSpawns.set(payload.requestId, `${payload.model} as "${payload.role}"`);
          }
          if (payload._tag === "SpawnApprovalResolved") unansweredSpawns.delete(payload.requestId);
          if (payload._tag === "MessageQueued" && payload.message.id !== undefined) {
            undelivered.set(payload.message.id, payload.message);
          }
          if (payload._tag === "MessageWithdrawn") undelivered.delete(payload.messageId);
          if (payload._tag === "MessageHeld" && payload.message.id !== undefined) {
            heldMessages.set(payload.message.id, payload.message);
          }
          if (payload._tag === "TurnInput") {
            for (const item of payload.items) {
              if (item._tag === "FromUser" && item.id) undelivered.delete(item.id);
              if (item._tag === "FromAgent" && item.id) heldMessages.delete(item.id);
            }
          }
          // Every message queued before a rewind went with the turns it replaced.
          if (payload._tag === "ConversationRewound") undelivered.clear();
        }
        // Forgotten before the new session can be reached, so a late answer finds nothing to allow.
        for (const requestId of unansweredSpawns.keys()) pendingSpawns.delete(requestId);
        if (heldMessages.size > 0) heldNotices.set(agentId, [...heldMessages.values()]);
        const rt = yield* startRuntime(
          info,
          directory,
          info.providerSessionId === undefined || startsAnew(history)
            ? {}
            : { resume: info.providerSessionId },
        );
        yield* Effect.forEach(
          unanswered,
          (requestId) => emit(rt, { _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" }),
          { discard: true },
        );
        yield* Effect.forEach(
          unansweredQuestions,
          (requestId) => emit(rt, { _tag: "QuestionResolved", requestId, outcome: "expired" }),
          { discard: true },
        );
        yield* Effect.forEach(
          unansweredSpawns.keys(),
          (requestId) => emit(rt, { _tag: "SpawnApprovalResolved", requestId, decision: "deny" }),
          { discard: true },
        );
        yield* setState(rt, "idle");

        const spawned = new Set(
          history.flatMap(({ payload }) => (payload._tag === "AgentSpawned" ? [payload.childId] : [])),
        );
        const gone = (yield* store.listAgents(thread.id).pipe(Effect.mapError(unavailable))).filter(
          // The advisor and reviewers aren't the lead's to spawn again: the next question or review
          // starts a new one.
          (agent) =>
            agent.parentId === agentId &&
            spawned.has(agent.id) &&
            !isHelper(agent) &&
            !runtimes.has(agent.id),
        );
        const notices: Array<InputItem> = [];
        // Told ahead of the messages that go on from it.
        const replay = replayNotice(history);
        const before: ReadonlyArray<InputItem> =
          replay === undefined ? [] : [{ _tag: "SystemNotice", text: replay }];
        // A session on the harness the lead was handed to hears the conversation with its first turn,
        // whatever starts it.
        const handoff = pendingHandoff(history);
        if (handoff === undefined) briefsOwed.delete(agentId);
        else briefsOwed.set(agentId, handoff);
        if (gone.length > 0) {
          notices.push({
            _tag: "SystemNotice",
            text: `Your session was resumed after it ended. The agents you spawned before (${gone
              .map((agent) => `${agent.id} "${agent.role}"`)
              .join(", ")}) are no longer running; spawn new ones if you still need them.`,
          });
        }
        const unheard = [...askedQuestions].filter(
          ([requestId]) =>
            unansweredQuestions.has(requestId) || (expiredAt.get(requestId) ?? -1) > lastTurnAt,
        );
        if (unheard.length > 0) {
          notices.push({
            _tag: "SystemNotice",
            text: `Your session ended before the user answered ${unheard
              .map(
                ([, [{ question }]]) =>
                  `"${question.length > 120 ? `${question.slice(0, 119)}…` : question}"`,
              )
              .join(", ")}. Ask again if you still need the answer.`,
          });
        }
        for (const [requestId, questions] of askedQuestions) {
          if ((dismissedAt.get(requestId) ?? -1) <= lastTurnAt) continue;
          notices.push({
            _tag: "SystemNotice",
            text: answerNotice(questions, { outcome: "dismissed" }),
            questionId: requestId,
          });
        }
        if (unansweredSpawns.size > 0) {
          notices.push({
            _tag: "SystemNotice",
            text: `Your session ended before the user answered your request to spawn ${[
              ...unansweredSpawns.values(),
            ].join(", ")}. Ask again if you still need it.`,
          });
        }
        return { rt, undelivered: [...before, ...undelivered.values()], notices };
      });

      /** The lead's live runtime, resuming its session first when it has stopped or failed. */
      const liveLead = (agentId: AgentId) =>
        Effect.suspend(() => {
          const live = runtimes.get(agentId);
          const kept = held.get(agentId);
          held.delete(agentId);
          return live !== undefined && !live.ended
            ? Effect.succeed({
                rt: live,
                undelivered: kept?.undelivered ?? ([] as ReadonlyArray<InputItem>),
                notices: kept?.notices ?? ([] as ReadonlyArray<InputItem>),
              })
            : resumeLead(agentId);
        });

      /**
       * Takes a lead's conversation back to before one of the user's messages: the session it goes on
       * in holds only what came before, by its harness's own fork where it has one, else a new session
       * told the conversation so far. The agents the replaced turns spawned stop, and their files stay
       * as they are. Resolves with the message it went back before.
       */
      const rewind = Effect.fn("Orchestrator.rewind")(function* (agentId: AgentId, messageId: string) {
        const live = runtimes.get(agentId);
        const stored =
          live?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (stored === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (stored.parentId !== undefined) {
          return yield* notAllowed("Only the conversation with a thread's lead can go back.");
        }
        const thread = Option.getOrUndefined(
          yield* store.getThread(stored.threadId).pipe(Effect.mapError(unavailable)),
        );
        if (thread === undefined) return yield* notFound(`Thread ${stored.threadId} does not exist.`);
        const events = yield* store.listEvents(agentId).pipe(Effect.mapError(unavailable));
        const point = rewindPoint(events, messageId);
        if ("problem" in point) {
          return yield* new OrchestratorError({ reason: "invalid", message: point.problem });
        }

        // The session the replaced turns ran in ends, and so do the agents they spawned.
        if (live !== undefined) yield* stopRuntime(live);
        held.delete(agentId);
        yield* Effect.forEach(
          point.spawned,
          (childId) => {
            const child = runtimes.get(childId);
            return child === undefined ? Effect.void : stopRuntime(child);
          },
          { discard: true },
        );
        // What the replaced turns still waited on is closed with them.
        const replaced = events.filter((event) => event.sequence >= point.fromSequence);
        const info = Option.getOrElse(
          yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)),
          () => stored,
        );
        const permissions = new Set<string>();
        const spawns = new Set<string>();
        for (const { payload } of replaced) {
          if (payload._tag === "PermissionRequested") permissions.add(payload.requestId);
          if (payload._tag === "PermissionResolved") permissions.delete(payload.requestId);
          if (payload._tag === "SpawnApprovalRequested") spawns.add(payload.requestId);
          if (payload._tag === "SpawnApprovalResolved") spawns.delete(payload.requestId);
        }
        for (const requestId of permissions) {
          yield* emitStored(info, { _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" });
        }
        for (const requestId of spawns) {
          pendingSpawns.delete(requestId);
          yield* emitStored(info, { _tag: "SpawnApprovalResolved", requestId, decision: "deny" });
        }

        let via = point.via;
        if (via === "fork") {
          const adapter = adapters.get(info.provider);
          const sessionId = info.providerSessionId;
          // A session that hasn't reported its id yet can't be forked; nor can a harness without forks.
          const forked =
            adapter?.fork === undefined ||
            !adapter.manifest.session.fork ||
            sessionId === undefined ||
            startsAnew(liveEvents(events))
              ? undefined
              : yield* adapter.fork({ cwd: threadDirectory(thread), sessionId, before: point.turn }).pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning(
                      `Couldn't fork ${info.provider} session ${sessionId}: ${error.message}`,
                    ),
                  ),
                  Effect.option,
                  Effect.map(Option.getOrUndefined),
                );
          if (forked === undefined) via = "replay";
          else {
            yield* store
              .updateAgent(agentId, { providerSessionId: forked, updatedAt: yield* now })
              .pipe(Effect.mapError(unavailable));
          }
        }
        yield* emitStored(info, {
          _tag: "ConversationRewound",
          fromSequence: point.fromSequence,
          messageId,
          via,
        });
        // Picked back up at once, so the thread reads as waiting for the user rather than stopped.
        const { undelivered, notices } = yield* resumeLead(agentId);
        held.set(agentId, { undelivered, notices });
        return point.message;
      });

      /** How long a handoff waits for the turn it stopped to end before it ends the session anyway. */
      const HANDOFF_STOP_TIMEOUT = "15 seconds";

      /**
       * Hands a lead to another harness (see `handOffLead`). A running turn is stopped and given time
       * to end, so the transcript records how it ended; what waited in its inbox stays: the user's
       * messages come back from the history, and the rest goes to the new session.
       */
      const handOff = Effect.fn("Orchestrator.handOff")(function* (agentId: AgentId, target: HandoffTarget) {
        const live = runtimes.get(agentId);
        const info =
          live?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (info.parentId !== undefined) {
          return yield* notAllowed("Only a thread's lead can be handed to another harness.");
        }
        if (target.provider === info.provider) {
          return yield* new OrchestratorError({
            reason: "invalid",
            message: `The lead already runs on ${info.provider}: switch its model instead.`,
          });
        }
        if (!adapters.has(target.provider)) {
          return yield* new OrchestratorError({
            reason: "unavailable",
            message: `No ${target.provider} adapter is installed.`,
          });
        }
        const thread = yield* threadInfo(info.threadId);
        if (thread.worktree !== undefined && thread.archivedAt !== undefined) {
          return yield* notAllowed(
            "This thread's worktree was removed when it was archived; restore it first.",
          );
        }

        const carried: Array<InputItem> = [];
        if (live !== undefined && !live.ended) {
          // Taken out first, so the stopped turn's end doesn't start another on the old harness.
          carried.push(...(yield* Queue.clear(live.inbox)).filter((item) => item._tag !== "FromUser"));
          live.userWaiting = false;
          const turn = live.turn;
          if (turn !== undefined) {
            yield* (live.session?.interrupt ?? Effect.void).pipe(Effect.ignore);
            yield* expireQuestions(live).pipe(Effect.ignore);
            yield* Deferred.await(turn).pipe(Effect.timeoutOption(HANDOFF_STOP_TIMEOUT));
          }
          yield* stopRuntime(live);
        }
        held.delete(agentId);

        const updatedAt = yield* now;
        const autoEffort = target.autoEffort === true;
        yield* store
          .updateAgent(agentId, {
            provider: target.provider,
            model: target.model,
            effort: target.effort ?? null,
            autoEffort,
            speed: target.speed ?? null,
            providerSessionId: null,
            updatedAt,
          })
          .pipe(Effect.mapError(unavailable));
        const {
          effort: _effort,
          autoEffort: _auto,
          speed: _speed,
          providerSessionId: _session,
          ...rest
        } = info;
        const next: AgentInfo = {
          ...rest,
          provider: target.provider,
          model: target.model,
          ...(target.effort ? { effort: target.effort } : {}),
          ...(autoEffort ? { autoEffort } : {}),
          ...(target.speed ? { speed: target.speed } : {}),
          updatedAt,
        };
        yield* emitStored(next, {
          _tag: "LeadHandedOff",
          from: { provider: info.provider, model: info.model },
          provider: target.provider,
          model: target.model,
          ...(target.effort ? { effort: target.effort } : {}),
          ...(autoEffort ? { autoEffort } : {}),
          ...(target.speed ? { speed: target.speed } : {}),
        });
        // Started at once, so the new harness's session is ready by the user's next message. What the
        // old session had still to take goes on now, with the brief; otherwise it waits for the user.
        const { rt, undelivered, notices } = yield* resumeLead(agentId);
        if (undelivered.length === 0 && carried.length === 0) held.set(agentId, { undelivered, notices });
        else {
          rt.userWaiting = undelivered.length > 0;
          yield* Queue.offerAll(rt.inbox, [...undelivered, ...notices, ...carried]);
        }
        return rt.info;
      });

      /**
       * Where restoring a lead's thread to before one of the user's messages goes back to: the turn
       * that delivered it, when that turn began, and the snapshot of the folder taken just before it.
       */
      const restorePoint = Effect.fn("Orchestrator.restorePoint")(function* (
        agentId: AgentId,
        messageId: string,
      ) {
        const lead =
          runtimes.get(agentId)?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (lead === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (lead.parentId !== undefined) {
          return yield* notAllowed("Only a thread's lead can go back to before one of your messages.");
        }
        const thread = yield* threadInfo(lead.threadId);
        const events = yield* store.listEvents(agentId).pipe(Effect.mapError(unavailable));
        const point = rewindPoint(events, messageId);
        if ("problem" in point) {
          return yield* new OrchestratorError({ reason: "invalid", message: point.problem });
        }
        const turn = events.find((event) => event.sequence === point.fromSequence);
        const snapshot = turn?.payload._tag === "TurnInput" ? turn.payload.files : undefined;
        return { lead, thread, events, point, since: turn?.at ?? 0, snapshot };
      });

      /** A file an agent named, relative to `folder` with forward slashes; none when it lies outside. */
      const inFolder = (folder: string, file: string) => {
        const relative = path.relative(folder, path.resolve(folder, file));
        return relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
          ? undefined
          : relative.replaceAll("\\", "/");
      };

      /** The files of `folder` a thread's agents changed in their turns since `since`. */
      const changedBy = Effect.fn("Orchestrator.changedBy")(function* (
        threadId: ThreadId,
        folder: string,
        since: number,
        now: string,
      ) {
        const events = yield* store
          .listThreadEvents(threadId, { tags: ["TurnInput", "FilesSaved", "FileChanged"] })
          .pipe(Effect.mapError(unavailable));
        const changed = new Set<string>();
        for (const agentEvents of Map.groupBy(events, (event) => event.agentId).values()) {
          const work = workSince(agentEvents, since);
          for (const file of work.files) {
            const relative = inFolder(folder, file);
            if (relative !== undefined) changed.add(relative);
          }
          for (const span of work.spans) {
            const to = span.to ?? now;
            if (span.from === to) continue;
            for (const { path: file } of yield* checkpoints.changes(folder, span.from, to)) changed.add(file);
          }
        }
        return changed;
      });

      /**
       * What restoring a thread's files to `snapshot` does: those its agents changed since `since` go
       * back, except those another thread in the same folder changed too. Absent for a chat.
       */
      const filePlan = Effect.fn("Orchestrator.filePlan")(function* (
        thread: ThreadInfo,
        since: number,
        snapshot: string | undefined,
      ) {
        if (thread.mode !== "work") return undefined;
        if (snapshot === undefined) {
          return {
            unavailable:
              "No snapshot of the folder was taken before this message, so its files stay as they are.",
          } as const;
        }
        const folder = threadDirectory(thread);
        return yield* Effect.gen(function* () {
          const now = yield* checkpoints.save(folder);
          const differing = yield* checkpoints.changes(folder, snapshot, now);
          if (differing.length === 0) return { restored: [], kept: [] };
          const ours = yield* changedBy(thread.id, folder, since, now);
          const theirs = new Map<string, string>();
          const neighbours = (yield* store.listThreads.pipe(Effect.mapError(unavailable))).filter(
            (other) =>
              other.id !== thread.id &&
              other.mode === "work" &&
              other.cwd !== undefined &&
              path.relative(other.cwd, folder) === "",
          );
          for (const other of neighbours) {
            for (const file of yield* changedBy(other.id, folder, since, now)) {
              if (!theirs.has(file)) theirs.set(file, other.title);
            }
          }
          return planRestore(differing, ours, theirs);
        }).pipe(
          // The conversation can still go back when the files can't be read.
          Effect.catchTag("CheckpointError", (error) =>
            Effect.succeed({ unavailable: error.message } as const),
          ),
        );
      });

      /** Whether going back to `point` copies the lead's session with its harness, or starts a new one. */
      const conversationVia = (
        lead: AgentInfo,
        events: ReadonlyArray<AgentEvent>,
        via: RestorePreview["conversation"],
      ): RestorePreview["conversation"] => {
        if (via !== "fork") return via;
        const adapter = adapters.get(lead.provider);
        const forks =
          adapter?.fork !== undefined &&
          adapter.manifest.session.fork &&
          lead.providerSessionId !== undefined &&
          !startsAnew(liveEvents(events));
        return forks ? "fork" : "replay";
      };

      /** The thread's agents besides its lead that are live: a restore stops them. */
      const liveChildren = (threadId: ThreadId) =>
        [...runtimes.values()].filter(
          (rt) => rt.info.threadId === threadId && rt.info.parentId !== undefined && !rt.ended,
        );

      const previewRestore = Effect.fn("Orchestrator.previewRestore")(function* (
        agentId: AgentId,
        messageId: string,
      ) {
        const { lead, thread, events, point, since, snapshot } = yield* restorePoint(agentId, messageId);
        // The user's messages from this one on: those the replaced turns delivered, and any still waiting.
        const delivered = new Set<string>();
        const going = new Set<string>();
        for (const { payload, sequence } of liveEvents(events)) {
          if (payload._tag === "TurnInput") {
            for (const item of payload.items) {
              if (item._tag !== "FromUser" || item.id === undefined) continue;
              (sequence >= point.fromSequence ? going : delivered).add(item.id);
            }
          }
          if (payload._tag === "MessageQueued" && payload.message.id !== undefined) {
            going.add(payload.message.id);
          }
          if (payload._tag === "MessageWithdrawn") going.delete(payload.messageId);
        }
        for (const id of delivered) going.delete(id);
        const files = yield* filePlan(thread, since, snapshot);
        return {
          messageId,
          messages: going.size,
          conversation: conversationVia(lead, events, point.via),
          agents: liveChildren(thread.id).map(({ info }) => ({
            id: info.id,
            role: info.role,
            model: info.model,
          })),
          ...(files === undefined ? {} : { files }),
        } satisfies RestorePreview;
      });

      const restoreBefore = Effect.fn("Orchestrator.restoreBefore")(function* (
        agentId: AgentId,
        messageId: string,
      ) {
        const { thread, since, snapshot } = yield* restorePoint(agentId, messageId);
        // Every agent stops before a file goes back, so none changes one meanwhile; the lead's
        // conversation then goes back, and it hears the agents it spawned are gone.
        yield* Effect.forEach(liveChildren(thread.id), stopRuntime, { discard: true });
        const message = yield* rewind(agentId, messageId);
        const plan = yield* filePlan(thread, since, snapshot);
        if (
          snapshot === undefined ||
          plan === undefined ||
          !("restored" in plan) ||
          plan.restored.length === 0
        ) {
          return message;
        }
        const paths = plan.restored.map((file) => file.path);
        yield* checkpoints.restore(threadDirectory(thread), snapshot, paths).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorError({
                reason: "unavailable",
                message: `The conversation went back, but the files couldn't: ${error.message}`,
              }),
          ),
        );
        const payload: EventPayload = { _tag: "FilesRestored", messageId, paths };
        const rt = runtimes.get(agentId);
        if (rt === undefined) {
          const info = yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable));
          if (Option.isSome(info)) yield* emitStored(info.value, payload);
        } else yield* emit(rt, payload);
        return message;
      });

      const revertTurn = Effect.fn("Orchestrator.revertTurn")(function* (
        agentId: AgentId,
        turnId: string,
        direction: "undone" | "redone",
      ) {
        const rt = runtimes.get(agentId);
        const info =
          rt?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        const thread = yield* threadInfo(info.threadId);
        const events = yield* store.listEvents(agentId).pipe(Effect.mapError(unavailable));
        let changed: Extract<EventPayload, { _tag: "TurnFilesChanged" }> | undefined;
        let state: "undone" | "redone" = "redone";
        for (const { payload } of events) {
          if (payload._tag === "TurnFilesChanged" && payload.turnId === turnId) changed = payload;
          if (payload._tag === "TurnFilesReverted" && payload.turnId === turnId) state = payload.direction;
        }
        if (changed === undefined || thread.mode !== "work") {
          return yield* notFound("That turn changed no files Cerium knows of.");
        }
        if (state === direction) {
          return yield* new OrchestratorError({
            reason: "invalid",
            message:
              direction === "undone"
                ? "That turn's files are already undone."
                : "That turn's files are already back.",
          });
        }
        const folder = threadDirectory(thread);
        // A file that changed since it was last put back stays as it is: going back would lose that change.
        const [expected, target] =
          direction === "undone" ? [changed.after, changed.before] : [changed.before, changed.after];
        const failed = (error: { readonly message: string }) =>
          new OrchestratorError({
            reason: "unavailable",
            message: `The files couldn't be put back: ${error.message}`,
          });
        const now = yield* checkpoints.save(folder).pipe(Effect.mapError(failed));
        const since = new Set(
          (yield* checkpoints.changes(folder, expected, now).pipe(Effect.mapError(failed))).map(
            (file) => file.path,
          ),
        );
        const paths = changed.files.map((file) => file.path);
        const back = paths.filter((file) => !since.has(file));
        const kept = paths.filter((file) => since.has(file));
        yield* checkpoints.restore(folder, target, back).pipe(Effect.mapError(failed));
        const payload: TurnFilesReverted = {
          _tag: "TurnFilesReverted",
          turnId,
          direction,
          paths: back,
          kept,
        };
        yield* rt === undefined ? emitStored(info, payload) : emit(rt, payload);
        return payload;
      });

      /** The agent's harness session, which a live agent only lacks while it starts. */
      const sessionOf = (rt: Runtime) =>
        rt.wakeSession.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              Effect.fromNullishOr(rt.session).pipe(
                Effect.mapError(() => notFound(`${rt.info.model} is still starting.`)),
              ),
            ),
          ),
        );

      const childrenOf = (leadId: AgentId) =>
        [...runtimes.values()].filter((candidate) => candidate.info.parentId === leadId);

      // Keep four recently used idle hosts warm. Only the session scope closes: the inbox and
      // turn loop remain reachable, so a delayed child report or message wakes the same agent.
      yield* Effect.gen(function* () {
        const idle = [...runtimes.values()]
          .filter((rt) => !rt.ended && !rt.sleeping && rt.info.state === "idle")
          .sort((a, b) => b.touchedAt - a.touchedAt);
        for (const rt of idle.slice(config.warmSessions)) {
          yield* rt.sessionPermit.withPermits(1)(
            Effect.gen(function* () {
              if (
                rt.ended ||
                rt.sleeping ||
                rt.info.state !== "idle" ||
                rt.turn !== undefined ||
                Date.now() - rt.touchedAt < Duration.toMillis(config.idleSessionTTL) ||
                Queue.sizeUnsafe(rt.inbox) > 0 ||
                rt.info.providerSessionId === undefined ||
                !adapters.get(rt.info.provider)?.manifest.session.resume ||
                waitsOnUser(rt.info.threadId) ||
                working(rt.info.threadId) ||
                rt.openCalls.size > 0
              )
                return;
              const sessionScope = rt.sessionScope;
              if (!sessionScope) return;
              rt.sleeping = true;
              yield* Scope.close(sessionScope, Exit.void);
              rt.session = undefined;
              rt.started = yield* Deferred.make<AgentSession, OrchestratorError>();
              rt.sessionScope = undefined;
              rt.storedRaw = undefined;
            }),
          );
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Couldn't retire idle sessions", cause)),
        Effect.delay(Math.max(10, Math.min(60_000, Duration.toMillis(config.idleSessionTTL) / 5))),
        Effect.forever,
        Effect.forkScoped,
      );

      // Runs before `agentsScope` closes, so agents are stopped rather than failed as the app quits.
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...runtimes.values()], stopRuntime, { discard: true }),
      );

      /**
       * Names a new thread from its first message while the lead works on it, unless the user
       * renamed the thread meanwhile. The lead's live feed tells the lists at once.
       */
      const nameThread = (
        lead: Runtime,
        startedAs: string,
        text: string,
        attachments: ReadonlyArray<Attachment>,
      ) =>
        Effect.gen(function* () {
          const { threadId, provider, model } = lead.info;
          const title = yield* titles.name({
            text,
            attachments: attachments.map((attachment) => attachment.name),
            lead: { provider, model },
          });
          if (Option.isNone(title)) return;
          const thread = yield* store.getThread(threadId).pipe(Effect.mapError(unavailable));
          if (Option.isNone(thread) || thread.value.title !== startedAs) return;
          yield* updateThread(threadId, { title: title.value });
          yield* emit(lead, { _tag: "ThreadRenamed", title: title.value });
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't name a thread", cause)));

      // No session survived the last exit, so no question asked before it can be answered. They are closed
      // in the threads now, not left for a device that reads the thread later to show as open.
      yield* Effect.gen(function* () {
        const asked = yield* store.listEventsByTag("QuestionAsked");
        if (asked.length === 0) return;
        const closed = new Set(
          (yield* store.listEventsByTag("QuestionResolved")).flatMap(({ agentId, payload }) =>
            payload._tag === "QuestionResolved" ? [`${agentId}|${payload.requestId}`] : [],
          ),
        );
        for (const { agentId, payload } of asked) {
          if (payload._tag !== "QuestionAsked" || closed.has(`${agentId}|${payload.requestId}`)) continue;
          const agent = Option.getOrUndefined(yield* store.getAgent(agentId));
          if (agent === undefined) continue;
          yield* emitStored(agent, {
            _tag: "QuestionResolved",
            requestId: payload.requestId,
            outcome: "expired",
          });
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Couldn't close the questions left open", cause)),
      );

      const createThread = Effect.fn("Orchestrator.createThread")(function* (input: CreateThreadInput) {
        if (input.mode === "work" && input.cwd === undefined) {
          return yield* new OrchestratorError({
            reason: "invalid",
            message: "A work thread needs a folder.",
          });
        }
        const createdAt = yield* now;
        const threadId = (yield* makeId("thr")) as ThreadId;
        const isolated: NewWorktree | undefined =
          input.mode === "work" && input.cwd !== undefined && input.worktree === true
            ? yield* worktrees.create(input.cwd, input.title).pipe(Effect.mapError(refusedWorktree))
            : undefined;
        const directory =
          isolated?.cwd ??
          (input.cwd !== undefined && input.mode === "work"
            ? input.cwd
            : path.join(config.chatDirectory, threadId));
        const thread: ThreadInfo = {
          id: threadId,
          title: input.title,
          mode: input.mode,
          ...(input.mode === "work" && input.cwd !== undefined ? { cwd: directory } : {}),
          ...(isolated ? { worktree: isolated.worktree } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        if (input.mode === "chat") {
          yield* fs
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.mapError(
                (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
              ),
            );
        }
        const effort = input.lead.effort;
        const lead: AgentInfo = {
          id: (yield* makeId("agt")) as AgentId,
          threadId,
          role: LEAD_ROLE,
          provider: input.lead.provider,
          model: input.lead.model,
          ...(effort ? { effort } : {}),
          ...(input.lead.autoEffort ? { autoEffort: true } : {}),
          ...(input.lead.speed ? { speed: input.lead.speed } : {}),
          access: input.mode === "chat" ? "readOnly" : input.lead.access,
          state: "idle",
          createdAt,
          updatedAt: createdAt,
        };
        yield* Effect.all([store.createThread(thread), store.createAgent(lead)], { discard: true }).pipe(
          Effect.mapError(unavailable),
          // A worktree no thread records would never be removed.
          Effect.onError(() =>
            isolated ? worktrees.remove(threadId, isolated.worktree).pipe(Effect.ignore) : Effect.void,
          ),
        );
        threadDirectories.set(threadId, directory);
        threadModes.set(threadId, input.mode);
        if (isolated) threadWorktrees.set(threadId, isolated.worktree);
        untitled.set(threadId, input.title);
        yield* startRuntime(lead, directory);
        // Setup makes the worktree usable, run in the thread's own terminal; the lead hears what runs
        // with its first turn, and what became of it when the command ends.
        if (isolated !== undefined) {
          const started = yield* scripts
            .start({
              kind: "setup",
              threadId,
              project: isolated.worktree.project,
              cwd: isolated.cwd,
              auto: true,
            })
            .pipe(Effect.option);
          yield* deliver(lead.id, {
            _tag: "SystemNotice",
            text: setupNote(Option.getOrUndefined(started)),
          });
        }
        return { thread, lead };
      });

      /**
       * The user's message to a lead; one a lead wrote for them when it started the thread says so.
       * With `rewindBefore`, the conversation first goes back to before that earlier message.
       */
      const acceptUserMessage = (
        agentId: AgentId,
        text: string,
        extras: UserMessageExtras & Pick<FromUser, "writtenBy"> = {},
        options: { readonly rewindBefore?: string } = {},
      ) => {
        const { attachments = [], mentions = [], writtenBy } = extras;
        if (text.trim() === "" && attachments.length === 0) {
          return Effect.fail(new OrchestratorError({ reason: "invalid", message: "The message is empty." }));
        }
        return acceptPermit.withPermits(1)(
          Effect.gen(function* () {
            if (options.rewindBefore !== undefined) yield* rewind(agentId, options.rewindBefore);
            const { rt, undelivered, notices } = yield* liveLead(agentId);
            const message: FromUser = {
              _tag: "FromUser",
              id: yield* makeId("msg"),
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(mentions.length > 0 ? { mentions } : {}),
              ...(writtenBy ? { writtenBy } : {}),
            };
            // Recorded before it waits on the session or a running turn, so the user sees it at once.
            yield* emit(rt, { _tag: "MessageQueued", message });
            // Offered together, so the user's messages and any notices make one turn.
            // A turn in progress takes it at its next step, between tool calls. Marked first: the turn
            // loop clears the mark when it takes the inbox.
            rt.userWaiting = true;
            yield* Queue.offerAll(rt.inbox, [...undelivered, message, ...notices]);
            const startedAs = untitled.get(rt.info.threadId);
            untitled.delete(rt.info.threadId);
            if (startedAs !== undefined && text.trim() !== "") {
              yield* Effect.forkIn(nameThread(rt, startedAs, text, attachments), layerScope);
            }
          }),
        );
      };

      return Orchestrator.of({
        createThread,

        sendUserMessage: (agentId, text, extras = {}) =>
          acceptUserMessage(agentId, text, {
            ...(extras.attachments ? { attachments: extras.attachments } : {}),
            ...(extras.mentions ? { mentions: extras.mentions } : {}),
          }),

        editMessage: (agentId, messageId, text, extras = {}) =>
          acceptUserMessage(
            agentId,
            text,
            {
              ...(extras.attachments ? { attachments: extras.attachments } : {}),
              ...(extras.mentions ? { mentions: extras.mentions } : {}),
            },
            { rewindBefore: messageId },
          ),

        rewindLead: (agentId, messageId) => acceptPermit.withPermits(1)(rewind(agentId, messageId)),

        previewRestore,

        restoreBefore: (agentId, messageId) => acceptPermit.withPermits(1)(restoreBefore(agentId, messageId)),
        // One at a time, and never beside a restore: each reads the files the other puts back.
        revertTurn: (agentId, turnId, direction) =>
          acceptPermit.withPermits(1)(revertTurn(agentId, turnId, direction)),

        // Ordered with the user's messages: one sent before the switch may still run on it, and a
        // lead being picked back up has its runtime before the switch is recorded.
        // Ordered with the user's messages, like a switch within the harness.
        handOffLead: (agentId, target) => acceptPermit.withPermits(1)(handOff(agentId, target)),

        switchModel: (agentId, picked) =>
          acceptPermit.withPermits(1)(
            Effect.gen(function* () {
              const rt = runtimes.get(agentId);
              const info =
                rt?.info ??
                Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
              if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
              if (info.parentId !== undefined) {
                return yield* notAllowed("Only a thread's lead can be switched to another model.");
              }
              const current = choiceOf(info);
              // No effort for the same model keeps the one it has, which its session also keeps.
              const { effort, model } =
                picked.effort === undefined && picked.model === current.model ? current : picked;
              // Auto stays as it is unless named: on it, a picked effort is the one it falls back to.
              const autoEffort = picked.autoEffort ?? current.autoEffort === true;
              // Likewise no speed for the same model keeps its speed, as a client before speeds asks.
              const speed =
                picked.speed === undefined && picked.model === current.model ? current.speed : picked.speed;
              const choice: ModelChoice = {
                model,
                ...(effort ? { effort } : {}),
                ...(autoEffort ? { autoEffort } : {}),
                ...(speed ? { speed } : {}),
              };
              if (
                choice.model === current.model &&
                choice.effort === current.effort &&
                choice.autoEffort === current.autoEffort &&
                choice.speed === current.speed
              ) {
                return info;
              }
              const switching = adapters.get(info.provider)?.manifest.switching;
              if (choice.model !== current.model && switching?.model !== true) {
                return yield* notAllowed(`${info.provider} can't switch a session to another model.`);
              }
              if (
                choice.effort !== undefined &&
                choice.effort !== current.effort &&
                switching?.effort !== true
              ) {
                return yield* notAllowed(`${info.provider} can't change a session's effort.`);
              }
              if (choice.speed !== undefined && choice.speed !== current.speed && switching?.speed !== true) {
                return yield* notAllowed(`${info.provider} can't change a session's speed.`);
              }
              return yield* recordModel(info, rt, choice);
            }),
          ),

        respondToPermission: (agentId, requestId, decision) =>
          runtime(agentId).pipe(Effect.flatMap((rt) => answerRequest(rt, requestId, decision))),

        answerQuestion: Effect.fn("Orchestrator.answerQuestion")(function* (
          agentId: AgentId,
          requestId: string,
          response: QuestionResponse,
        ) {
          const rt = yield* runtime(agentId);
          const open = openQuestions.get(agentId)?.get(requestId);
          if (open === undefined) {
            return yield* notFound("That question is closed: it was answered, or its agent stopped waiting.");
          }
          if (response.outcome === "answered") {
            const problem = answerProblem(open, response.answers);
            if (problem !== undefined) {
              return yield* new OrchestratorError({ reason: "invalid", message: problem });
            }
          }
          closeQuestion(agentId, requestId);
          const given = tidyResponse(response);
          yield* emit(
            rt,
            given.outcome === "dismissed"
              ? { _tag: "QuestionResolved", requestId, outcome: "dismissed" }
              : { _tag: "QuestionResolved", requestId, outcome: "answered", answers: given.answers },
          );
          const notice: InputItem = {
            _tag: "SystemNotice",
            text: answerNotice(open, given),
            questionId: requestId,
          };
          // An answer wakes the agent; a dismissal waits for its next turn.
          if (given.outcome === "dismissed") {
            heldNotices.set(agentId, [...(heldNotices.get(agentId) ?? []), notice]);
          } else yield* deliver(agentId, notice);
        }),

        askUser: Effect.fn("Orchestrator.askUser")(function* (
          callerId: AgentId,
          questions: readonly [Question, ...Array<Question>],
        ) {
          const asker = yield* runtime(callerId);
          if (isAdvisor(asker.info)) {
            return yield* notAllowed("You are the advisor: answer the question you were asked.");
          }
          const problem = questionProblem(questions);
          if (problem !== undefined)
            return yield* new OrchestratorError({ reason: "invalid", message: problem });
          const waiting = openQuestions.get(callerId)?.size ?? 0;
          if (waiting >= MAX_OPEN_QUESTIONS) {
            return yield* new OrchestratorError({
              reason: "budgetExceeded",
              message: `You already have ${waiting} questions waiting for the user. Wait for their answers.`,
            });
          }
          const requestId = yield* makeId("q");
          const open = openQuestions.get(callerId) ?? new Map<string, OpenQuestion>();
          openQuestions.set(callerId, open.set(requestId, questions));
          yield* emit(asker, { _tag: "QuestionAsked", requestId, questions });
          return { requestId };
        }),

        syncUserTasks: Effect.fn("Orchestrator.syncUserTasks")((tasks: ReadonlyArray<TaskEntry>) =>
          Effect.sync(() => {
            for (const entry of tasks) {
              const held = mirroredTasks.get(entry.id);
              if (held === undefined || entry.updatedAt > held.updatedAt) {
                mirroredTasks.set(entry.id, entry);
              }
            }
          }),
        ),

        addUserTask: Effect.fn("Orchestrator.addUserTask")(function* (callerId, task) {
          const caller = yield* tasksWriterOf(callerId);
          const title = task.title.trim();
          const note = task.note?.trim();
          const folder = task.folder?.trim();
          if (title === "") {
            return yield* new OrchestratorError({ reason: "invalid", message: "Name the task." });
          }
          if (title.length > MAX_TASK_TITLE) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The title may be ${MAX_TASK_TITLE} characters at most.`,
            });
          }
          if ((note ?? "").length > MAX_TASK_NOTE) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The note may be ${MAX_TASK_NOTE} characters at most.`,
            });
          }
          const createdAt = yield* Clock.currentTimeMillis;
          const content: Record<string, Schema.Json> = { title, createdAt };
          if (note) content.note = note;
          if (folder) content.folder = folder;
          if (JSON.stringify(content).length > MAX_TASK_BYTES) {
            return yield* new OrchestratorError({ reason: "invalid", message: "The task is too long." });
          }
          const entry = yield* putTask({
            id: yield* makeId("task"),
            task: content as Schema.Json,
          });
          yield* emit(caller, { _tag: "UserTasksChanged", tasks: [entry] });
          return entry;
        }),

        removeUserTask: Effect.fn("Orchestrator.removeUserTask")(function* (callerId, which) {
          const caller = yield* tasksWriterOf(callerId);
          const entry =
            which.title === undefined ? mirroredTasks.get(which.id ?? "") : yield* taskByTitle(which.title);
          if (entry === undefined || entry.task === undefined) {
            return yield* notFound(
              "No task like that is on the list. See `list_tasks` for the ids and titles it holds.",
            );
          }
          const gone = yield* putTask({ id: entry.id });
          yield* emit(caller, { _tag: "UserTasksChanged", tasks: [gone] });
          return gone;
        }),

        userTasks: Effect.suspend(() =>
          Effect.succeed([...mirroredTasks.values()].filter((entry) => entry.task !== undefined)),
        ),

        resolveSpawnApproval: Effect.fn("Orchestrator.resolveSpawnApproval")(function* (
          requestId: string,
          approval: SpawnApproval,
        ) {
          const pending = pendingSpawns.get(requestId);
          if (pending === undefined) return yield* notFound(`No spawn request ${requestId} is waiting.`);
          pendingSpawns.delete(requestId);
          const lead = yield* runtime(pending.leadId);
          yield* emit(lead, { _tag: "SpawnApprovalResolved", requestId, decision: approval.decision });
          if (approval.decision === "deny") {
            return yield* deliver(lead.info.id, {
              _tag: "SystemNotice",
              text: `The user declined spawning ${pending.request.model} as "${pending.request.role}".`,
            });
          }
          const effort = pending.request.effort;
          const target: SpawnTarget = {
            ...(approval.replacement ?? {
              provider: pending.request.provider ?? lead.info.provider,
              model: pending.request.model,
            }),
            ...(effort ? { effort } : {}),
          };
          const childId = yield* launchChild(lead, pending.request, target);
          yield* deliver(lead.info.id, {
            _tag: "SystemNotice",
            text: `The user approved your spawn request: agent ${childId} (${pending.request.role}) is running ${target.model}.`,
          });
        }),

        answerChildPermission: Effect.fn("Orchestrator.answerChildPermission")(function* (
          callerId: AgentId,
          childId: AgentId,
          requestId: string,
          decision: PermissionDecision,
        ) {
          const child = yield* runtime(childId);
          if (child.info.parentId !== callerId) {
            return yield* notAllowed(`Agent ${childId} is not your child.`);
          }
          if (!closeLeadRequest(childId, requestId)) {
            return yield* notFound(
              `Agent ${childId} isn't waiting on request ${requestId}: it was answered, or the agent's turn ended.`,
            );
          }
          yield* answerRequest(child, requestId, decision);
        }),

        interruptAgent: Effect.fn("Orchestrator.interruptAgent")(function* (
          agentId: AgentId,
          options?: { readonly includeChildren?: boolean },
        ) {
          const rt = yield* runtime(agentId);
          // A session still starting has no turn to interrupt.
          yield* (rt.session?.interrupt ?? Effect.void).pipe(
            Effect.mapError(
              (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
            ),
          );
          // What the agent was waiting on the user for is no longer worth an answer; the adapter closes
          // its own, and this closes any it didn't, so a question never outlives the stop.
          yield* expireQuestions(rt).pipe(Effect.ignore);
          yield* releaseOwnRequests(rt, "The user interrupted the turn this request was part of.");
          if (options?.includeChildren ?? config.stopChildrenWithLead) {
            yield* Effect.forEach(
              childrenOf(agentId),
              (child) =>
                (child.session?.interrupt ?? Effect.void).pipe(
                  Effect.ignore,
                  Effect.andThen(expireQuestions(child).pipe(Effect.ignore)),
                ),
              {
                discard: true,
              },
            );
          }
        }),

        steerAgent: Effect.fn("Orchestrator.steerAgent")(function* (agentId: AgentId) {
          yield* steer(yield* runtime(agentId));
        }),

        compactAgent: Effect.fn("Orchestrator.compactAgent")(function* (agentId: AgentId) {
          const rt = yield* runtime(agentId);
          if (rt.ended) return yield* notFound(`Agent ${agentId} is not running.`);
          const session = yield* sessionOf(rt);
          const compact = session.compact;
          if (compact === undefined || adapters.get(rt.info.provider)?.manifest.compact !== true) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `${rt.info.provider} can't compact a conversation when asked.`,
            });
          }
          const working = new OrchestratorError({
            reason: "invalid",
            message: "The agent is working: compact its conversation once its turn ends.",
          });
          if (rt.turn !== undefined || rt.info.state === "running" || rt.info.state === "queued") {
            return yield* working;
          }
          // Held before this returns, so a message sent right after waits for the compaction.
          if (!(yield* rt.turnPermit.takeIfAvailable(1))) return yield* working;
          yield* Effect.forkIn(
            compactTurn(rt, compact).pipe(Effect.ensuring(rt.turnPermit.release(1))),
            rt.scope,
          );
        }),

        // Under the accept permit, so a message being accepted can't slip between taking the inbox
        // and putting the rest back.
        withdrawMessage: (agentId: AgentId, messageId: string) =>
          acceptPermit.withPermits(1)(
            Effect.gen(function* () {
              const isIt = (item: InputItem) => item._tag === "FromUser" && item.id === messageId;
              const live = runtimes.get(agentId);
              const session = live !== undefined && !live.ended ? live : undefined;
              // A lead picked back up after a rewind holds what waited for the user's next message.
              const kept = held.get(agentId);
              let found = kept?.undelivered.some(isIt) === true;
              if (found && kept !== undefined) {
                held.set(agentId, { ...kept, undelivered: kept.undelivered.filter((item) => !isIt(item)) });
              }
              if (!found && session !== undefined) {
                // Only what still waits in the inbox: one the turn loop has taken is on its way in.
                const waiting = yield* Queue.clear(session.inbox);
                const rest = waiting.filter((item) => !isIt(item));
                found = rest.length < waiting.length;
                yield* Queue.offerAll(session.inbox, rest);
                // Nothing left of the user's to steer the running turn for.
                if (found) session.userWaiting = rest.some((item) => item._tag === "FromUser");
              }
              if (!found && session === undefined) {
                // A lead without a session keeps what it never took in its history, for its next one.
                const events = liveEvents(
                  yield* store
                    .listEvents(agentId, {
                      tags: ["MessageQueued", "MessageWithdrawn", "TurnInput", "ConversationRewound"],
                    })
                    .pipe(Effect.mapError(unavailable)),
                );
                found = undeliveredIds(events).has(messageId);
              }
              if (!found) return false;
              const withdrawn = { _tag: "MessageWithdrawn", messageId } as const;
              if (session !== undefined) yield* emit(session, withdrawn);
              else {
                const info =
                  live?.info ??
                  Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
                if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
                yield* emitStored(info, withdrawn);
              }
              return true;
            }),
          ),

        stopAgent: Effect.fn("Orchestrator.stopAgent")(function* (agentId: AgentId) {
          const rt = yield* runtime(agentId);
          yield* stopRuntime(rt);
          // A lead waiting on this child would otherwise wait for a result that never comes. An
          // advisor's askers hear from `releaseAdvisor` instead, and a reviewer reports to nobody.
          if (rt.info.parentId !== undefined && !isHelper(rt.info)) {
            yield* deliver(rt.info.parentId, {
              _tag: "SystemNotice",
              text: `The user stopped agent ${rt.info.id} "${rt.info.role}"; it will not report back. Carry on without it, or spawn a new agent if you still need that work.`,
            });
          }
        }),

        stopThread: Effect.fn("Orchestrator.stopThread")(function* (threadId: ThreadId) {
          yield* threadInfo(threadId);
          const members = [...runtimes.values()].filter((rt) => rt.info.threadId === threadId && !rt.ended);
          const deny = {
            decision: "deny",
            scope: "once",
            message: "The user stopped everything in this thread.",
          } as const;
          let approvals = 0;
          // Requests are denied before the turns are interrupted, so a harness blocked on one is free to end.
          for (const rt of members) {
            const waiting = new Set([
              ...(pendingPermissions.get(rt.info.id) ?? []),
              ...(leadRequests.get(rt.info.id) ?? []),
            ]);
            leadRequests.delete(rt.info.id);
            approvals += waiting.size;
            yield* Effect.forEach(
              waiting,
              (requestId) => answerRequest(rt, requestId, deny).pipe(Effect.ignore),
              { discard: true, concurrency: "unbounded" },
            );
          }
          for (const [requestId, { leadId }] of [...pendingSpawns]) {
            const lead = runtimes.get(leadId);
            if (lead?.info.threadId !== threadId) continue;
            pendingSpawns.delete(requestId);
            approvals++;
            yield* emit(lead, { _tag: "SpawnApprovalResolved", requestId, decision: "deny" });
          }
          const working = members.filter((rt) => rt.info.state === "running" || rt.info.state === "queued");
          for (const rt of working) rt.halted = true;
          yield* Effect.forEach(
            members,
            (rt) =>
              Effect.gen(function* () {
                // Notices waiting to be delivered would start the turn the user just stopped; their own
                // messages stay queued, as they wrote them.
                const waiting = yield* Queue.clear(rt.inbox);
                yield* Queue.offerAll(
                  rt.inbox,
                  waiting.filter((item) => item._tag === "FromUser"),
                );
                yield* (rt.session?.interrupt ?? Effect.void).pipe(Effect.ignore);
                yield* expireQuestions(rt).pipe(Effect.ignore);
              }),
            { discard: true, concurrency: "unbounded" },
          );
          return { agents: working.length, approvals };
        }),

        listThreads: store.listThreads.pipe(Effect.mapError(unavailable)),

        renameThread: (threadId, title) => {
          const trimmed = title.trim();
          if (trimmed === "" || trimmed.length > MAX_THREAD_TITLE) {
            return Effect.fail(
              new OrchestratorError({
                reason: "invalid",
                message: `A thread's title needs 1 to ${MAX_THREAD_TITLE} characters.`,
              }),
            );
          }
          return updateThread(threadId, { title: trimmed });
        },

        setThreadArchived: Effect.fn("Orchestrator.setThreadArchived")(function* (
          threadId: ThreadId,
          archived: boolean,
          options: PutAwayOptions = {},
        ) {
          if (archived && (working(threadId) || waitsOnUser(threadId))) {
            return yield* notAllowed(
              "A thread can't be archived while its agents are working or waiting on you.",
            );
          }
          const thread = yield* threadInfo(threadId);
          if (thread.worktree !== undefined && archived !== (thread.archivedAt !== undefined)) {
            if (archived) {
              yield* removeWorktree(thread.id, thread.worktree, options);
            } else {
              yield* worktrees.restore(thread.worktree).pipe(Effect.mapError(refusedWorktree));
              // A restored worktree starts empty of what setup installs, so it runs again, whether
              // or not the thread's lead is listening; the terminal shows its output.
              yield* scripts
                .start({
                  kind: "setup",
                  threadId,
                  project: thread.worktree.project,
                  cwd: thread.cwd ?? thread.worktree.root,
                  auto: true,
                })
                .pipe(Effect.ignore);
            }
          }
          return yield* updateThread(
            threadId,
            archived ? { archivedAt: yield* now, laterUntil: null } : { archivedAt: null },
          );
        }),

        setThreadLater: (threadId: ThreadId, until: number | undefined) =>
          updateThread(threadId, { laterUntil: until ?? null }),

        deleteThread: Effect.fn("Orchestrator.deleteThread")(function* (
          threadId: ThreadId,
          options: PutAwayOptions = {},
        ) {
          const thread = yield* threadInfo(threadId);
          if (working(threadId) || waitsOnUser(threadId)) {
            return yield* notAllowed(
              "A thread can't be deleted while its agents are working or waiting on you.",
            );
          }
          // An archived thread's worktree is gone already; its branch keeps any commits.
          if (thread.worktree !== undefined && thread.archivedAt === undefined) {
            yield* removeWorktree(thread.id, thread.worktree, options);
          }
          // Sessions end first, so nothing they record lands after the rows are gone.
          yield* Effect.forEach(
            [...runtimes.values()].filter((rt) => rt.info.threadId === threadId),
            stopRuntime,
            { discard: true },
          );
          threadDirectories.delete(threadId);
          threadModes.delete(threadId);
          yield* store.deleteThread(threadId).pipe(Effect.mapError(unavailable));
        }),

        worktreeChanges: Effect.fn("Orchestrator.worktreeChanges")(function* (threadId: ThreadId) {
          const { worktree, archivedAt } = yield* threadInfo(threadId);
          if (worktree === undefined || archivedAt !== undefined) return { uncommitted: 0, unmerged: 0 };
          return yield* worktrees.changes(worktree).pipe(Effect.mapError(refusedWorktree));
        }),

        listAgents: (threadId) => store.listAgents(threadId).pipe(Effect.mapError(unavailable)),

        threadOverviews: Effect.gen(function* () {
          const threads = yield* store.listThreads;
          const byThread = Map.groupBy(yield* store.listAllAgents, (agent) => agent.threadId);
          return threads.map((thread): ThreadOverview => ({
            thread,
            agents: byThread.get(thread.id) ?? [],
            awaitingApproval: waitsOnUser(thread.id),
          }));
        }).pipe(Effect.mapError(unavailable)),

        events: Stream.fromPubSub(feed),

        catalog: catalog.entries,

        spawn: Effect.fn("Orchestrator.spawn")(function* (callerId: AgentId, request: SpawnRequest) {
          const lead = yield* runtime(callerId);
          if (lead.info.parentId !== undefined) {
            return yield* notAllowed("Only a thread's lead can spawn agents.");
          }
          if (request.role === ADVISOR_ROLE) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The role "${ADVISOR_ROLE}" belongs to the user's advisor: ask it with \`ask_advisor\`, or give your agent another role.`,
            });
          }
          if (request.role === REVIEWER_ROLE) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The role "${REVIEWER_ROLE}" belongs to the reviews the user starts: give your agent another role, such as "reviewer".`,
            });
          }
          const target = resolveTarget(yield* catalog.entries, request);
          if (target !== undefined) {
            return {
              _tag: "Spawned",
              agentId: yield* launchChild(lead, request, target),
            } satisfies SpawnOutcome;
          }
          if (request.provider === undefined) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `"${request.model}" is not in the catalog. Call list_models, or pass a provider to ask the user.`,
            });
          }
          if (!adapters.has(request.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${request.provider} adapter is installed.`,
            });
          }
          const requestId = yield* makeId("spawn");
          pendingSpawns.set(requestId, { leadId: callerId, request });
          yield* emit(lead, {
            _tag: "SpawnApprovalRequested",
            requestId,
            role: request.role,
            provider: request.provider,
            model: request.model,
            ...(request.effort ? { effort: request.effort } : {}),
            access: childAccess(lead, request),
            prompt: request.prompt,
          });
          return { _tag: "PendingApproval", requestId } satisfies SpawnOutcome;
        }),

        startThread: Effect.fn("Orchestrator.startThread")(function* (
          callerId: AgentId,
          request: ThreadRequest,
        ) {
          const caller = yield* runtime(callerId);
          if (caller.info.parentId !== undefined) {
            return yield* notAllowed("Only a thread's lead can start threads; ask your lead.");
          }
          const title = request.title?.trim();
          if (title !== undefined && (title === "" || title.length > MAX_THREAD_TITLE)) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `A title is 1 to ${MAX_THREAD_TITLE} characters; leave it out to have the thread named from its prompt.`,
            });
          }
          const own: SpawnTarget = {
            provider: caller.info.provider,
            model: caller.info.model,
            ...((request.effort ?? caller.info.effort)
              ? { effort: request.effort ?? caller.info.effort }
              : {}),
          };
          const target =
            request.model === undefined || request.model === caller.info.model
              ? own
              : resolveTarget(yield* catalog.entries, {
                  model: request.model,
                  ...(request.effort ? { effort: request.effort } : {}),
                });
          if (target === undefined) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `"${request.model}" is not in the catalog. Call list_models, or leave model out to start the thread on yours.`,
            });
          }
          if (!adapters.has(target.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${target.provider} adapter is installed.`,
            });
          }
          const origin = yield* threadInfo(caller.info.threadId);
          yield* spend(
            "threads",
            config.threadBudget,
            (recent) =>
              `Agents have started ${recent} threads recently, the most allowed. Ask the user to start the rest.`,
          );
          // A thread in a worktree starts from the project, not from the worktree's folder.
          const folder = origin.worktree?.project ?? origin.cwd;
          const started = yield* createThread({
            title: title ?? (origin.mode === "work" ? "New thread" : "New chat"),
            mode: origin.mode,
            ...(folder !== undefined ? { cwd: folder } : {}),
            worktree: request.worktree ?? origin.worktree !== undefined,
            lead: {
              ...target,
              // A new lead starts on Auto while the router is on, unless the caller named an effort.
              ...(request.effort === undefined && (yield* routerOn) ? { autoEffort: true } : {}),
              access: narrowAccess(caller.info.access, request.access ?? caller.info.access),
            },
          });
          if (title !== undefined) untitled.delete(started.thread.id);
          yield* acceptUserMessage(started.lead.id, request.prompt, {
            writtenBy: { agentId: callerId, threadId: origin.id, threadTitle: origin.title },
          });
          return started;
        }),

        sendMessage: Effect.fn("Orchestrator.sendMessage")(function* (
          callerId: AgentId,
          to: AgentId,
          text: string,
          options: { readonly reply?: boolean } = {},
        ) {
          const from = yield* runtime(callerId);
          const stopped = notFound(
            `Agent ${to} isn't running, so it can't take messages: it was stopped, or its thread waits for the user to pick it back up. \`list_threads\` shows which leads are working.`,
          );
          const recipient = yield* runtime(to).pipe(Effect.mapError(() => stopped));
          // An agent whose session ended would drop the message while the sender heard it was delivered.
          if (recipient.ended) return yield* stopped;
          if (isAdvisor(from.info)) {
            return yield* notAllowed(
              "An advisor only answers the question it was asked; your reply reaches the agent that asked it.",
            );
          }
          if (isAdvisor(recipient.info)) {
            return yield* notAllowed("Put questions to the advisor with `ask_advisor`.");
          }
          if (isReviewer(from.info)) {
            return yield* notAllowed("A reviewer messages nobody: end your turn with the review.");
          }
          if (isReviewer(recipient.info)) {
            return yield* notAllowed("That agent is reviewing a diff for the user and takes no messages.");
          }
          const crossThread = from.info.threadId !== recipient.info.threadId;
          if (crossThread && (from.info.parentId !== undefined || recipient.info.parentId !== undefined)) {
            return yield* notAllowed(
              "Across threads only leads can message each other; ask that thread's lead.",
            );
          }
          if (text.length > config.maxDeliveredChars) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The message is ${text.length} characters; the limit is ${config.maxDeliveredChars}. Summarize it.`,
            });
          }
          yield* spendBudget(`${callerId}->${to}`, to);
          const message = {
            _tag: "FromAgent",
            agentId: callerId,
            threadId: from.info.threadId,
            text,
          } as const;
          // Within a thread agents wait on each other's messages. Across threads most are heads-ups the
          // receiver can read with its next turn; a turn started for one rereads its whole context.
          const answers = awaitedReplies.get(to)?.delete(callerId) === true;
          if (crossThread && options.reply === true) {
            awaitedReplies.set(callerId, (awaitedReplies.get(callerId) ?? new Set()).add(to));
          }
          if (!crossThread || options.reply === true || answers) {
            yield* deliver(to, message);
            return { held: false };
          }
          const held: FromAgent = { ...message, id: yield* makeId("msg") };
          // Recorded first, so the receiver's thread shows it and a resumed session still hears it.
          yield* emit(recipient, { _tag: "MessageHeld", message: held });
          heldNotices.set(to, [...(heldNotices.get(to) ?? []), held]);
          return { held: true };
        }),

        askAdvisor: Effect.fn("Orchestrator.askAdvisor")(function* (callerId: AgentId, question: string) {
          const asker = yield* runtime(callerId);
          if (isAdvisor(asker.info)) {
            return yield* notAllowed("You are the advisor: answer the question you were asked.");
          }
          const { advisor: chosen } = yield* settings.get;
          if (!chosen.enabled || chosen.model === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message:
                "The user hasn't turned on an advisor (Settings → Tools). Carry on, or ask the user instead.",
            });
          }
          if (!adapters.has(chosen.model.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `The advisor runs on ${chosen.model.provider}, and no ${chosen.model.provider} adapter is installed.`,
            });
          }
          if (question.length > config.maxDeliveredChars) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The question is ${question.length} characters; the limit is ${config.maxDeliveredChars}. Shorten it, and name files for the advisor to read instead of pasting them.`,
            });
          }
          yield* spendBudget(`${callerId}->${ADVISOR_ROLE}`, "the advisor");
          const model = chosen.model;
          return yield* advisorPermit.withPermits(1)(
            Effect.gen(function* () {
              const advisor = yield* advisorFor(asker, model);
              advisorQuestions.set(advisor.info.id, [
                ...(advisorQuestions.get(advisor.info.id) ?? []),
                callerId,
              ]);
              yield* deliver(advisor.info.id, {
                _tag: "FromAgent",
                agentId: callerId,
                threadId: asker.info.threadId,
                text: question,
              });
              // One that ended while the question was put to it would leave the asker waiting.
              if (advisor.ended) yield* releaseAdvisor(advisor);
              return { advisorId: advisor.info.id };
            }),
          );
        }),

        startReview: Effect.fn("Orchestrator.startReview")(function* (
          threadId: ThreadId,
          reviewer: {
            readonly provider: ProviderId;
            readonly model: string;
            readonly effort?: ReasoningEffort;
          },
          prompt: string,
        ) {
          const thread = yield* threadInfo(threadId);
          if (thread.worktree !== undefined && thread.archivedAt !== undefined) {
            return yield* notAllowed(
              "This thread's worktree was removed when it was archived; restore it first.",
            );
          }
          if (!adapters.has(reviewer.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${reviewer.provider} adapter is installed to review with.`,
            });
          }
          const lead = (yield* store.listAgents(threadId).pipe(Effect.mapError(unavailable))).find(
            (agent) => agent.parentId === undefined,
          );
          if (lead === undefined) return yield* notFound(`Thread ${threadId} has no lead.`);
          const createdAt = yield* now;
          const info: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId,
            parentId: lead.id,
            role: REVIEWER_ROLE,
            provider: reviewer.provider,
            model: reviewer.model,
            ...(reviewer.effort ? { effort: reviewer.effort } : {}),
            access: "readOnly",
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createAgent(info).pipe(Effect.mapError(unavailable));
          const spawned: EventPayload = {
            _tag: "AgentSpawned",
            childId: info.id,
            role: info.role,
            provider: info.provider,
            model: info.model,
            access: info.access,
          };
          const live = runtimes.get(lead.id);
          yield* live === undefined ? emitStored(lead, spawned) : emit(live, spawned);
          const reply = yield* Deferred.make<string, OrchestratorError>();
          reviews.set(info.id, reply);
          const rt = yield* startRuntime(info, threadDirectories.get(threadId) ?? threadDirectory(thread), {
            initial: { _tag: "SystemNotice", text: prompt },
          });
          // One that ended as it started would leave the review waiting.
          if (rt.ended) yield* releaseReview(rt);
          return { agentId: info.id, reply: Deferred.await(reply) };
        }),

        killChild: Effect.fn("Orchestrator.killChild")(function* (callerId: AgentId, childId: AgentId) {
          const child = yield* runtime(childId);
          if (child.info.parentId !== callerId) {
            return yield* notAllowed(`Agent ${childId} is not your child.`);
          }
          yield* stopRuntime(child);
        }),

        agent: (agentId) => runtime(agentId).pipe(Effect.map((rt) => rt.info)),

        notify: (agentId, text) => deliver(agentId, { _tag: "SystemNotice", text }),

        wake: (agentId, text) =>
          acceptPermit
            .withPermits(1)(
              Effect.gen(function* () {
                const notice: InputItem = { _tag: "SystemNotice", text };
                const live = runtimes.get(agentId);
                if (live !== undefined && !live.ended) return yield* Queue.offer(live.inbox, notice);
                const stored = Option.getOrUndefined(
                  yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)),
                );
                if (stored === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
                if (stored.parentId !== undefined) {
                  return yield* notAllowed("That agent has ended: tell the thread's lead instead.");
                }
                const { rt, undelivered, notices } = yield* liveLead(agentId);
                yield* Queue.offerAll(rt.inbox, [...undelivered, notice, ...notices]);
              }),
            )
            .pipe(Effect.asVoid),

        requestApproval: Effect.fn("Orchestrator.requestApproval")(function* (callerId, request) {
          const rt = yield* runtime(callerId);
          const allow: PermissionDecision = { decision: "allow", scope: "once" };
          const deny = (message: string): PermissionDecision => ({
            decision: "deny",
            scope: "once",
            message,
          });
          if (rt.info.access === "readOnly") {
            return deny("You are read-only here: ask your lead or the user to do this.");
          }
          if (rt.info.access === "auto" || rt.info.access === "fullAccess") return allow;
          if (allowedTools.get(callerId)?.has(request.toolName) === true) return allow;
          const requestId = yield* makeId("perm");
          const done = yield* Deferred.make<PermissionDecision>();
          const payload = { _tag: "PermissionRequested", requestId, ...request } as const;
          if (rt.info.parentId !== undefined) {
            const lead = runtimes.get(rt.info.parentId);
            if (lead === undefined || lead.ended) {
              return deny("Your lead isn't running to approve this, so it was denied.");
            }
            ownRequests.set(requestId, { agentId: callerId, toolName: request.toolName, done });
            leadRequests.set(callerId, (leadRequests.get(callerId) ?? new Set<string>()).add(requestId));
            yield* deliver(lead.info.id, { _tag: "SystemNotice", text: permissionNotice(rt.info, payload) });
          } else {
            ownRequests.set(requestId, { agentId: callerId, toolName: request.toolName, done });
            pendingPermissions.set(
              callerId,
              (pendingPermissions.get(callerId) ?? new Set<string>()).add(requestId),
            );
            yield* emit(rt, payload);
          }
          // A call its harness gave up on takes its request with it.
          return yield* Deferred.await(done).pipe(
            Effect.onInterrupt(() =>
              answerRequest(rt, requestId, deny("The call was cancelled.")).pipe(Effect.ignore),
            ),
          );
        }),

        threadEvents: (threadId, options) =>
          store.listThreadEvents(threadId, { withoutImages: options?.withoutImages === true }).pipe(
            Effect.map((events) =>
              options?.streamed === true ? [...events, ...streamed.soFar(threadId)] : events,
            ),
            Effect.mapError(unavailable),
          ),

        awaitingApproval: waitsOnUser,
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(ThreadTitles.layer, Condenser.layer)));
}
