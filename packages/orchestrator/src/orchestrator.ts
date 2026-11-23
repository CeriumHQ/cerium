import type { PermissionDecision } from "@cerium/harness";
import type {
  AgentEvent,
  AgentId,
  AgentInfo,
  EventPayload,
  FromUser,
  HistoryPage,
  HistoryRequest,
  LimitPolicy,
  LiveEventDelivery,
  ProviderId,
  Question,
  QuestionResponse,
  ReasoningEffort,
  RestorePreview,
  TaskEntry,
  ThreadId,
  ThreadInfo,
  ThreadOverview,
  ThreadOverviewUpdate,
  TurnFilesReverted,
  WorkspaceChoice,
  WorktreeChanges,
} from "@cerium/protocol";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { makeAgentControls } from "./agentControls.ts";
import { makeAgentSessions } from "./agentSessions.ts";
import { makeAgentTeam } from "./agentTeam.ts";
import { makeOrchestratorContext } from "./context.ts";
import type { MessageOptions } from "./delivery.ts";
import { makeEffortRouting } from "./effortRouting.ts";
import { type OrchestratorError, unavailable } from "./errors.ts";
import { makeSuggestFollowup } from "./followup.ts";
import { Condenser } from "./handoff.ts";
import { HelperUsage } from "./helperUsage.ts";
import { makeInbox } from "./inbox.ts";
import type {
  AssistantThreadRequest,
  CreateThreadInput,
  ForkThreadInput,
  HandoffTarget,
  ModelChoice,
  PutAwayOptions,
  SpawnApproval,
  SpawnOutcome,
  SpawnRequest,
  ThreadRequest,
  UserMessageExtras,
} from "./inputs.ts";
import { makeLeadSwitching } from "./leadSwitching.ts";
import { makeLimitPauses } from "./limitPauses.ts";
import { makeOverviewWatch } from "./overviewWatch.ts";
import { makeProjectRun, type ProjectRunAnswer, type ProjectRunRequest } from "./projectRun.ts";
import { makeRewinding } from "./rewinding.ts";
import type { CatalogEntry } from "./services.ts";
import { SideQuestions, type SideExchange } from "./sideQuestion.ts";
import { makeThreadCreation } from "./threadCreation.ts";
import { makeThreadLifecycle } from "./threadLifecycle.ts";
import { makeThreadWorkspace } from "./threadWorkspace.ts";
import { ThreadTitles } from "./titles.ts";
import { makeTurns } from "./turns.ts";
import { makeUserRequests } from "./userRequests.ts";
import { makeUserTasks } from "./userTasks.ts";

export { defaultAssistantModel } from "./inputs.ts";
export type {
  AssistantThreadRequest,
  CreateThreadInput,
  ForkThreadInput,
  HandoffTarget,
  ModelChoice,
  PutAwayOptions,
  SpawnApproval,
  SpawnOutcome,
  SpawnRequest,
  ThreadRequest,
  UserMessageExtras,
} from "./inputs.ts";

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    createThread(
      input: CreateThreadInput,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    previewForkThread(
      input: Pick<ForkThreadInput, "threadId" | "turn">,
    ): Effect.Effect<{ readonly snapshot: boolean }, OrchestratorError>;
    forkThread(
      input: ForkThreadInput,
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
      paths?: ReadonlyArray<string>,
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
     * Asks the agent's harness to stop one of its background tasks. Refused for a harness that can't;
     * a task that already ended is no error.
     */
    stopBackgroundTask(agentId: AgentId, taskId: string): Effect.Effect<void, OrchestratorError>;
    /**
     * Answers a question about a thread from its lead's conversation, even mid-turn, and keeps
     * nothing: no event, no message in the lead's session, no effect on its turn. `earlier` is the
     * side questions already asked in the same pop-over.
     */
    askSideQuestion(
      agentId: AgentId,
      question: string,
      earlier: ReadonlyArray<SideExchange>,
    ): Effect.Effect<string, OrchestratorError>;
    suggestFollowup(
      threadId: ThreadId,
      agentId: AgentId,
      afterSeq: number,
    ): Effect.Effect<string | null, OrchestratorError>;
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
    /**
     * Moves a thread's conversation to another checkout, on a new session there. With `carryOn`, for
     * a move the lead asked for and ended its turn to let through, the lead is told where it now works
     * and goes on with its task at once; otherwise it waits for the user's next message.
     */
    moveThread(
      threadId: ThreadId,
      choice: WorkspaceChoice,
      options?: { readonly carryOn?: boolean },
    ): Effect.Effect<ThreadInfo, OrchestratorError>;
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
     * Starts a thread that goes on from `threadId` in its folder, under its title, with a lead on the
     * same harness, model, effort and access, and archives the old one. A worktree passes to the new
     * thread whole, so archiving the old one leaves it be. The new lead's session starts fresh and
     * takes no message: the user sends the first, the brief `continuationBrief` writes. Refused while
     * the old thread's agents work or wait on the user, like archiving.
     */
    continueThread(
      threadId: ThreadId,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    /**
     * Puts a thread off until `until`, when it comes back to the user's inbox; `undefined` brings it
     * back now. Archiving a thread ends its wait.
     */
    setThreadLater(
      threadId: ThreadId,
      until: number | undefined,
    ): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * What the thread does when its harness's limit runs out; `undefined` goes back to following the
     * setting for all threads. A thread already paused stays so until it resumes.
     */
    setThreadOnLimit(
      threadId: ThreadId,
      policy: LimitPolicy | undefined,
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
    readonly watchThreadOverviews: Stream.Stream<ThreadOverviewUpdate>;
    /** Legacy live events from every agent, including streamed text. */
    readonly events: Stream.Stream<AgentEvent>;
    /** Live events from every agent, without streamed text. */
    readonly activity: Stream.Stream<AgentEvent>;
    readonly watchActivity: Stream.Stream<LiveEventDelivery>;
    readonly watchActivityWithoutTools: Stream.Stream<LiveEventDelivery>;
    watchThreadEvents(threadId: ThreadId): Stream.Stream<LiveEventDelivery>;

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
     * Starts a thread for the user at an assistant's request, whose lead begins on the prompt as the
     * user's message, marked as sent through that assistant. Assistants together start as many
     * threads as `threadBudget` lets agents.
     */
    startAssistantThread(
      request: AssistantThreadRequest,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    /** Sends a note, blocking question, or correlated reply to another thread's lead. */
    sendMessage(
      callerId: AgentId,
      to: AgentId,
      text: string,
      options?: MessageOptions,
    ): Effect.Effect<
      { readonly held: boolean; readonly requestId?: string; readonly reason?: string },
      OrchestratorError
    >;
    continueChild(
      callerId: AgentId,
      childId: AgentId,
      prompt: string,
    ): Effect.Effect<void, OrchestratorError>;
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
     * Starts, stops or restarts the caller's thread's project run (or setup) in the thread's own
     * terminal, or reads how it stands, with its last lines of output. Starting asks like a command
     * does (`requestApproval`), and runs only a command the user confirmed, never a guess; a start
     * waits briefly for the run to print its address or end, and tells the caller instead of the
     * lead. Refused for an advisor, a reviewer, and a thread with no project folder.
     */
    projectRun(
      callerId: AgentId,
      request: ProjectRunRequest,
    ): Effect.Effect<ProjectRunAnswer, OrchestratorError>;
    /**
     * Every persisted event in a thread, in order. With `streamed`, each block still streaming follows
     * them as one delta holding its text so far, in its first delta's place: streamed text is never
     * stored, and a reader joining mid-reply would otherwise start it partway through.
     */
    threadEvents(
      threadId: ThreadId,
      options?: { readonly streamed?: boolean; readonly withoutImages?: boolean },
    ): Effect.Effect<ReadonlyArray<AgentEvent>, OrchestratorError>;
    threadHistory(threadId: ThreadId, page: HistoryRequest): Effect.Effect<HistoryPage, OrchestratorError>;
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
      const ctx = yield* makeOrchestratorContext;
      const { store, catalog, feeds, streamed, runtimes, layerScope, overviewDirty, emit, emitStored } = ctx;
      const suggestFollowup = yield* makeSuggestFollowup;
      const helperUsage = yield* HelperUsage;

      const requests = makeUserRequests(ctx);
      const routing = makeEffortRouting(ctx);
      const turns = makeTurns(ctx, requests, {
        routeEffort: routing.routeEffort,
        // A lead at its limit pauses or moves to another harness, both of which pick it back up on
        // the sessions these turns run in; reached only once a turn has run, long after both exist.
        handleLimit: (rt, hit) => limits.handleLimit(rt, hit),
      });
      const workspace = makeThreadWorkspace(ctx);
      const sessions = makeAgentSessions(ctx, turns, workspace);
      const leads = makeLeadSwitching(ctx, sessions);
      const limits = makeLimitPauses(ctx, sessions, leads);
      const rewinding = makeRewinding(ctx, sessions);
      const inbox = makeInbox(ctx, sessions, rewinding);
      const team = makeAgentTeam(ctx, sessions);
      const controls = makeAgentControls(ctx, turns, requests);
      const tasks = makeUserTasks(ctx);
      const threads = makeThreadCreation(ctx, sessions, workspace, inbox);
      const lifecycle = makeThreadLifecycle(ctx, sessions, workspace);
      const projectRun = makeProjectRun(ctx, requests.requestApproval);

      yield* workspace.forwardScriptNews;
      yield* Effect.forkScoped(sessions.retireIdleSessions);
      // Runs before `agentsScope` closes, so agents are stopped rather than failed as the app quits.
      yield* Effect.addFinalizer(() => ctx.shutDown);
      yield* Effect.forkIn(limits.recoverPauses, layerScope);
      yield* requests.expireLeftoverQuestions;
      const watchThreadOverviews = yield* makeOverviewWatch(lifecycle.threadOverviews, overviewDirty);

      const orchestrator: Orchestrator["Service"] = Orchestrator.of({
        createThread: threads.createThread,
        previewForkThread: threads.previewForkThread,
        forkThread: threads.forkThread,
        sendUserMessage: inbox.sendUserMessage,
        editMessage: inbox.editMessage,
        rewindLead: rewinding.rewindLead,
        previewRestore: rewinding.previewRestore,
        restoreBefore: rewinding.restoreBefore,
        revertTurn: rewinding.revertTurn,
        handOffLead: leads.handOffLead,
        switchModel: leads.switchModel,
        respondToPermission: requests.respondToPermission,
        answerQuestion: requests.answerQuestion,
        askUser: requests.askUser,
        syncUserTasks: tasks.syncUserTasks,
        addUserTask: tasks.addUserTask,
        removeUserTask: tasks.removeUserTask,
        userTasks: tasks.userTasks,
        resolveSpawnApproval: team.resolveSpawnApproval,
        answerChildPermission: requests.answerChildPermission,
        interruptAgent: controls.interruptAgent,
        steerAgent: controls.steerAgent,
        compactAgent: controls.compactAgent,
        stopBackgroundTask: controls.stopBackgroundTask,
        suggestFollowup,
        askSideQuestion: controls.askSideQuestion,
        withdrawMessage: inbox.withdrawMessage,
        stopAgent: controls.stopAgent,
        stopThread: controls.stopThread,
        listThreads: lifecycle.listThreads,
        moveThread: lifecycle.moveThread,
        renameThread: lifecycle.renameThread,
        setThreadArchived: lifecycle.setThreadArchived,
        continueThread: threads.continueThread,
        setThreadLater: lifecycle.setThreadLater,
        setThreadOnLimit: lifecycle.setThreadOnLimit,
        deleteThread: lifecycle.deleteThread,
        worktreeChanges: lifecycle.worktreeChanges,
        listAgents: lifecycle.listAgents,
        threadOverviews: lifecycle.threadOverviews,
        watchThreadOverviews,

        events: feeds.events,
        activity: feeds.activity,
        watchActivity: feeds.watchActivity,
        watchActivityWithoutTools: feeds.watchActivityWithoutTools,
        watchThreadEvents: feeds.watchThread,

        catalog: catalog.entries,
        spawn: team.spawn,
        startThread: threads.startThread,
        startAssistantThread: threads.startAssistantThread,
        continueChild: team.continueChild,
        sendMessage: team.sendMessage,
        askAdvisor: team.askAdvisor,
        startReview: team.startReview,
        killChild: team.killChild,
        agent: team.agent,
        notify: inbox.notify,
        wake: inbox.wake,
        requestApproval: requests.requestApproval,

        threadEvents: (threadId, options) =>
          store.listThreadEvents(threadId, { withoutImages: options?.withoutImages === true }).pipe(
            Effect.map((events) =>
              options?.streamed === true ? [...events, ...streamed.soFar(threadId)] : events,
            ),
            Effect.mapError(unavailable),
          ),

        threadHistory: (threadId, page) =>
          store.historyPage(threadId, page).pipe(
            Effect.map((read) => ({
              ...read,
              events:
                page.before === undefined && page.state !== true
                  ? [...read.events, ...streamed.soFar(threadId)]
                  : read.events,
            })),
            Effect.mapError(unavailable),
          ),

        projectRun,
        awaitingApproval: ctx.waitsOnUser,
      });
      yield* helperUsage.events.pipe(
        Stream.runForEach((reading) =>
          Effect.gen(function* () {
            const rt = runtimes.get(reading.agentId);
            const payload: EventPayload =
              reading.usage === undefined
                ? {
                    _tag: "HelperCallStarted",
                    callId: reading.callId,
                    provider: reading.provider,
                    model: reading.model,
                    purpose: reading.purpose,
                  }
                : {
                    _tag: "UsageReported",
                    ...reading.usage,
                    helperCallId: reading.callId,
                    provider: reading.provider,
                    model: reading.model,
                    purpose: reading.purpose,
                    cause: reading.purpose,
                  };
            if (rt !== undefined) return yield* emit(rt, payload);
            const stored = yield* store.getAgent(reading.agentId).pipe(Effect.mapError(unavailable));
            if (Option.isSome(stored)) yield* emitStored(stored.value, payload);
          }),
        ),
        Effect.forkScoped,
      );
      return orchestrator;
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(ThreadTitles.layer, Condenser.layer, SideQuestions.layer)),
    Layer.provide(HelperUsage.layer),
  );
}
