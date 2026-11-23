import type { PermissionDecision } from "@cerium/harness";
import type {
  AgentId,
  AgentInfo,
  AgentState,
  EventId,
  EventPayload,
  InputItem,
  ThreadId,
  ThreadInfo,
  ThreadMode,
  ThreadWorktree,
} from "@cerium/protocol";
import { Store, type ThreadPatch } from "@cerium/store";
import {
  Clock,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Queue,
  RcMap,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { checkoutOperations } from "./checkoutOperations.ts";
import { MessageDelivery } from "./delivery.ts";
import { EffortDecider } from "./effort.ts";
import { notFound, OrchestratorError, unavailable } from "./errors.ts";
import { makeEventFeeds } from "./eventFeeds.ts";
import { Condenser, type pendingHandoff } from "./handoff.ts";
import type { ModelChoice, SpawnRequest } from "./inputs.ts";
import { choiceOf, isAdvisor, isHelper, isReviewer, type OpenQuestion, type Runtime } from "./runtime.ts";
import { ProjectScripts } from "./scripts.ts";
import {
  Adapters,
  BusEndpoint,
  Catalog,
  Checkpoints,
  OrchestratorConfig,
  Worktrees,
  type OrchestratorSettings,
} from "./services.ts";
import { UserSettings } from "./settings.ts";
import { SideQuestions } from "./sideQuestion.ts";
import { StreamedText } from "./streamed.ts";
import { ThreadTitles } from "./titles.ts";
import { commandOf, FolderActivity, type TurnWork } from "./turnFiles.ts";

/** Events the store never keeps: streamed text, and new titles, which the thread's record holds. */
const isEphemeral = (payload: EventPayload) =>
  payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta" || payload._tag === "ThreadRenamed";

/** The store's operations, named so the context's type can be written out. */
type StoreShape = Store["Service"];
interface StoreService extends StoreShape {}

/**
 * What every part of the orchestrator shares: the services it runs on, what it holds of each live
 * agent and thread, and the operations the rest build on: recording an agent's events, delivering
 * its input, its state, reading and locking threads, and stopping an agent.
 */
export const makeOrchestratorContext = Effect.gen(function* () {
  const store: StoreService = yield* Store;
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
  const sideQuestions = yield* SideQuestions;
  const condenser = yield* Condenser;
  const worktrees = yield* Worktrees;
  const checkpoints = yield* Checkpoints;
  const scripts = yield* ProjectScripts;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Scope.Scope;
  // Agents' sessions live in their own scope, which closes after the layer's finalizer that stops
  // each agent (`shutDown`): closed first, a session would end under a live agent and mark it failed, as new
  // activity in its thread.
  const agentsScope = yield* Scope.fork(layerScope);

  const runtimes = new Map<AgentId, Runtime>();
  const threadDirectories = new Map<ThreadId, string>();
  const threadModes = new Map<ThreadId, ThreadMode>();
  /** The worktree of each live thread that runs in one, for its agents' instructions. */
  const threadWorktrees = new Map<ThreadId, ThreadWorktree>();
  /** New threads' worktrees still being checked out, each done when its checkout ends. */
  const checkouts = new Map<ThreadId, Deferred.Deferred<void, OrchestratorError>>();
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
   * Notices each agent hears with its next turn, whatever starts it, rather than starting one: a
   * dismissed question, or another thread's heads-up, isn't worth waking an agent whose context may
   * hold hundreds of thousands of tokens.
   */
  const heldNotices = new Map<AgentId, Array<InputItem>>();
  /**
   * The other threads' leads each lead asked with `reply`, whose next message to it starts its turn
   * rather than waiting: the answer it ended its turn to wait for.
   */
  const messageDelivery = new MessageDelivery();
  /** Each thread's live advisor. */
  const advisors = new Map<ThreadId, Runtime>();
  /** The agents waiting on each advisor's answers, in the order they asked. */
  const advisorQuestions = new Map<AgentId, Array<AgentId>>();
  /** One advisor starts at a time, so agents asking together share it. */
  const advisorPermit = yield* Semaphore.make(1);
  /** Each live reviewer's review, settled with its final message once its turn ends. */
  const reviews = new Map<AgentId, Deferred.Deferred<string, OrchestratorError>>();
  const feeds = yield* makeEventFeeds;
  const overviewDirty = yield* Queue.sliding<void>(1);
  const metadataChanges = yield* store.overviewChanges;
  yield* Stream.fromSubscription(metadataChanges).pipe(
    Stream.runForEach(() => Queue.offer(overviewDirty, undefined)),
    Effect.forkScoped,
  );
  /** Threads still waiting for their first message to name them, with the title they started with. */
  const untitled = new Map<ThreadId, string>();
  /** What a lead picked back up after a rewind keeps for the user's next message. */
  const held = new Map<
    AgentId,
    { readonly undelivered: ReadonlyArray<InputItem>; readonly notices: ReadonlyArray<InputItem> }
  >();
  /** The leads handed to another harness whose new session hasn't heard the conversation yet. */
  const briefsOwed = new Map<AgentId, NonNullable<ReturnType<typeof pendingHandoff>>>();
  /** The timers that end the pauses of leads waiting for their harness's limit to reset. */
  const pauseTimers = new Map<AgentId, Fiber.Fiber<void>>();
  /** The app is quitting: its agents stop, but their pauses go on for the next start. */
  let quitting = false;

  // Sessions don't survive a restart, so agents a previous run left live are stopped; a lead
  // resumes its harness session when the user next messages it.
  yield* store.stopLiveAgents.pipe(Effect.mapError(unavailable));
  /**
   * One user message accepted at a time, so messages sent together keep their order and don't
   * start two sessions for one lead.
   */
  const threadLocks = yield* RcMap.make({ lookup: (_id: ThreadId) => Semaphore.make(1) });
  const checkout = checkoutOperations();
  const inThread =
    (id: ThreadId, writes = false, destination?: string) =>
    <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RcMap.get(threadLocks, id);
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const directory = threadDirectories.get(id) ?? threadDirectory(yield* threadInfo(id));
              const folders = yield* Effect.forEach(
                destination ? [directory, destination] : [directory],
                (folder) =>
                  fs.realPath(folder).pipe(
                    Effect.orElseSucceed(() => path.resolve(folder)),
                    Effect.map((name) => (process.platform === "win32" ? name.toLowerCase() : name)),
                  ),
              );
              return yield* checkout(folders, writes, operation);
            }),
          );
        }),
      );

  /** An agent's record: its runtime's while it is live, else the store's; none when it doesn't exist. */
  const findAgent = (agentId: AgentId) =>
    Effect.gen(function* () {
      return (
        runtimes.get(agentId)?.info ??
        Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)))
      );
    });

  /** Like `findAgent`, refused when the agent doesn't exist. */
  const agentInfo = (agentId: AgentId) =>
    Effect.flatMap(findAgent(agentId), (info) =>
      info === undefined ? Effect.fail(notFound(`Agent ${agentId} does not exist.`)) : Effect.succeed(info),
    );

  const forAgent =
    (id: AgentId, writes = false) =>
    <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const info = yield* agentInfo(id);
        return yield* inThread(info.threadId, writes)(operation);
      });

  const makeId = (prefix: string) =>
    crypto.randomUUIDv7().pipe(
      Effect.map((uuid) => `${prefix}_${uuid}`),
      Effect.orDie,
    );

  const runtime = (agentId: AgentId) =>
    Effect.fromNullishOr(runtimes.get(agentId)).pipe(
      Effect.mapError(() => notFound(`Agent ${agentId} is not running.`)),
    );

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
      yield* feeds.publish(event);
      switch (payload._tag) {
        case "PermissionRequested":
        case "PermissionResolved":
        case "QuestionAsked":
        case "QuestionResolved":
        case "SpawnApprovalRequested":
        case "SpawnApprovalResolved":
          yield* Queue.offer(overviewDirty, undefined);
      }
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

  /** Records an agent's event on its runtime when it has one, else after its stored events. */
  const emitTo = (info: AgentInfo, rt: Runtime | undefined, payload: EventPayload) =>
    rt === undefined ? emitStored(info, payload) : emit(rt, payload);

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
      yield* emitTo(next, rt, payload);
      return next;
    });

  const deliver = (agentId: AgentId, item: InputItem) =>
    Effect.gen(function* () {
      const target = runtimes.get(agentId);
      if (target === undefined || target.ended) {
        return yield* Effect.logWarning(`Dropped ${item._tag} for ${agentId}: agent is not running`);
      }
      target.touchedAt = yield* Clock.currentTimeMillis;
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

  /** Holds an item for the agent's next turn, whatever starts it, rather than starting one. */
  const holdNotice = (agentId: AgentId, item: InputItem) => {
    heldNotices.set(agentId, [...(heldNotices.get(agentId) ?? []), item]);
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

  /** Takes a question out of those waiting; what it was, or nothing when it was not waiting. */
  const closeQuestion = (agentId: AgentId, requestId: string): OpenQuestion | undefined => {
    const open = openQuestions.get(agentId);
    const found = open?.get(requestId);
    open?.delete(requestId);
    if (open?.size === 0) openQuestions.delete(agentId);
    return found;
  };

  /** Records that the agent's background tasks are gone, when it had any. */
  const clearBackground = (rt: Runtime) =>
    Effect.suspend(() => {
      if (rt.background === 0) return Effect.void;
      rt.background = 0;
      return emit(rt, { _tag: "BackgroundTasksChanged", tasks: [] });
    });

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

  const cancelPauseTimer = (agentId: AgentId) =>
    Effect.suspend(() => {
      const timer = pauseTimers.get(agentId);
      pauseTimers.delete(agentId);
      return timer === undefined ? Effect.void : Fiber.interrupt(timer);
    });

  /**
   * Ends a pause the user ended: they sent a message, or stopped the agent. Nothing happens for a
   * lead that isn't paused.
   */
  const endPause = (rt: Runtime, by: "message" | "stopped") =>
    Effect.gen(function* () {
      const gate = rt.pause;
      const timed = pauseTimers.has(rt.info.id);
      if (gate === undefined && !timed) return;
      rt.pause = undefined;
      yield* cancelPauseTimer(rt.info.id);
      yield* emit(rt, { _tag: "LimitResumed", by });
      if (gate !== undefined) yield* Deferred.succeed(gate, undefined);
    });

  const now = Clock.currentTimeMillis;

  /** The live agents of a thread. */
  const threadRuntimes = (threadId: ThreadId) =>
    [...runtimes.values()].filter((rt) => rt.info.threadId === threadId);

  const childrenOf = (leadId: AgentId) =>
    [...runtimes.values()].filter((candidate) => candidate.info.parentId === leadId);

  const isFreeChild = (rt: Runtime) =>
    rt.info.parentId !== undefined &&
    !isHelper(rt.info) &&
    !rt.ended &&
    rt.info.state === "idle" &&
    rt.turn === undefined &&
    !rt.preparingTurn &&
    Queue.sizeUnsafe(rt.inbox) === 0 &&
    rt.openCalls.size === 0 &&
    rt.background === 0 &&
    messageDelivery.taskFor(rt.info.id) === undefined &&
    (leadRequests.get(rt.info.id)?.size ?? 0) === 0 &&
    (openQuestions.get(rt.info.id)?.size ?? 0) === 0;

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
      (rt) => rt.info.threadId === threadId && (rt.info.state === "running" || rt.info.state === "queued"),
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

  /** The folder a thread's agents run in: the work thread's own, or a chat's private one. */
  const threadDirectory = (thread: ThreadInfo) =>
    thread.mode === "work" && thread.cwd !== undefined
      ? thread.cwd
      : path.join(config.chatDirectory, thread.id);

  const stopRuntime = (rt: Runtime) =>
    Effect.gen(function* () {
      yield* expireQuestions(rt).pipe(Effect.ignore);
      // Stopping a paused lead ends its pause; quitting leaves it for the next start to pick up.
      if (!quitting) yield* endPause(rt, "stopped").pipe(Effect.ignore);
      runtimes.delete(rt.info.id);
      yield* endWork(rt.info.id);
      pendingPermissions.delete(rt.info.id);
      for (const [requestId, pending] of pendingSpawns) {
        if (pending.leadId === rt.info.id) pendingSpawns.delete(requestId);
      }
      allowedTools.delete(rt.info.id);
      held.delete(rt.info.id);
      briefsOwed.delete(rt.info.id);
      leadRequests.delete(rt.info.id);
      // A resumed session finds what it hadn't heard in the thread's history.
      heldNotices.delete(rt.info.id);
      const cancelled = messageDelivery.taskFor(rt.info.id);
      messageDelivery.remove(rt.info.id);
      yield* setState(rt, "stopped").pipe(Effect.ignore);
      rt.ended = true;
      yield* Scope.close(rt.scope, Exit.void);
      const parent = cancelled === undefined ? undefined : runtimes.get(cancelled.from);
      if (
        cancelled !== undefined &&
        !messageDelivery.groupPending(cancelled) &&
        parent !== undefined &&
        !parent.ended
      ) {
        yield* deliver(parent.info.id, {
          _tag: "SystemNotice",
          text: `Agent ${rt.info.id} stopped. Any completed results in its group are included with this notice.`,
        });
      }
    });

  /** Ends every live agent's session in a thread. */
  const stopThreadAgents = (threadId: ThreadId) =>
    Effect.forEach(threadRuntimes(threadId), stopRuntime, { discard: true });

  /** The app is quitting: its agents stop, while their pauses go on for the next start. */
  const shutDown = Effect.suspend(() => {
    quitting = true;
    return Effect.forEach([...runtimes.values()], stopRuntime, { discard: true });
  });

  return {
    store,
    adapters,
    catalog,
    bus,
    config,
    settings,
    decider,
    routerOn,
    titles,
    sideQuestions,
    condenser,
    worktrees,
    checkpoints,
    scripts,
    fs,
    path,
    crypto,
    layerScope,
    agentsScope,
    runtimes,
    threadDirectories,
    threadModes,
    threadWorktrees,
    checkouts,
    pendingSpawns,
    pendingPermissions,
    leadRequests,
    openQuestions,
    ownRequests,
    allowedTools,
    heldNotices,
    messageDelivery,
    advisors,
    advisorQuestions,
    advisorPermit,
    reviews,
    feeds,
    overviewDirty,
    untitled,
    held,
    briefsOwed,
    pauseTimers,
    streamed,
    inThread,
    forAgent,
    findAgent,
    agentInfo,
    makeId,
    runtime,
    now,
    beginWork,
    endWork,
    emit,
    emitStored,
    emitTo,
    recordModel,
    deliver,
    withHeld,
    holdNotice,
    releaseAdvisor,
    releaseReview,
    setState,
    closeQuestion,
    clearBackground,
    expireQuestions,
    cancelPauseTimer,
    endPause,
    threadRuntimes,
    childrenOf,
    isFreeChild,
    awaitingApproval,
    waitsOnUser,
    working,
    updateThread,
    spend,
    threadInfo,
    threadDirectory,
    stopRuntime,
    stopThreadAgents,
    shutDown,
  };
});

export type OrchestratorContext = Effect.Success<typeof makeOrchestratorContext>;
