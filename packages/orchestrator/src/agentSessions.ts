import type { AgentSession } from "@cerium/harness";
import type { AgentId, AgentInfo, EventPayload, InputItem } from "@cerium/protocol";
import { Cause, Clock, Deferred, Duration, Effect, Exit, Option, Queue, Scope } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { noAdapter, notAllowed, notFound, OrchestratorError, unavailable } from "./errors.ts";
import { pendingHandoff } from "./handoff.ts";
import { PROMPT_VERSION, systemPrompt, type Neighbour } from "./prompts.ts";
import { answerNotice } from "./questions.ts";
import { liveEvents, replayNotice, startsAnew } from "./rewind.ts";
import { isHelper, makeRuntime, type OpenQuestion, type Runtime } from "./runtime.ts";
import type { Turns } from "./turns.ts";
import type { ThreadWorkspace } from "./threadWorkspace.ts";

/**
 * What resuming a lead reads of its history: the requests it waited on, the turns, messages and
 * rewinds of its conversation, and the agents it spawned. Its tool calls and their output, most of
 * a long history, say nothing about any of it.
 */
const RESUME_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "ForkContext",
  "PermissionRequested",
  "PermissionResolved",
  "QuestionAsked",
  "QuestionResolved",
  "SpawnApprovalRequested",
  "SpawnApprovalResolved",
  "MessageQueued",
  "MessageWithdrawn",
  "MessageHeld",
  "NoticeHeld",
  "TurnInput",
  "MessageCompleted",
  "SessionStarted",
  "ConversationRewound",
  "LeadHandedOff",
  "WorkspaceMoved",
  "AgentSpawned",
];

/**
 * Agents' harness sessions: making an agent live, picking a stopped lead back up on its session, and
 * putting idle sessions to sleep until the agent's next turn wakes them.
 */
export const makeAgentSessions = (ctx: OrchestratorContext, turns: Turns, workspace: ThreadWorkspace) => {
  const {
    store,
    adapters,
    bus,
    config,
    settings,
    path,
    agentsScope,
    runtimes,
    threadDirectories,
    threadModes,
    threadWorktrees,
    pendingSpawns,
    pendingPermissions,
    openQuestions,
    heldNotices,
    messageDelivery,
    held,
    briefsOwed,
    agentInfo,
    emit,
    deliver,
    setState,
    clearBackground,
    isFreeChild,
    stopRuntime,
    waitsOnUser,
    working,
    threadDirectory,
  } = ctx;
  const { consumeEvents, savesFiles, snapshotFor, turnLoop } = turns;
  const { ensureWorktree } = workspace;

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
   * behind it, after `prepare` (a new worktree's checkout), and a failure to start is told in its
   * transcript.
   */
  const startRuntime = (
    info: AgentInfo,
    cwd: string,
    options: {
      readonly initial?: InputItem;
      readonly resume?: string;
      readonly prepare?: Effect.Effect<void, OrchestratorError>;
      readonly includeUserMcpServers?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const adapter = adapters.get(info.provider);
      if (adapter === undefined) {
        return yield* noAdapter(info.provider);
      }
      const last = yield* store.lastSequence(info.id).pipe(Effect.mapError(unavailable));
      const scope = yield* Scope.fork(agentsScope);
      const rt = yield* makeRuntime(info, {
        scope,
        sequence: Option.match(last, { onNone: () => 0, onSome: (sequence) => sequence + 1 }),
        fresh: options.resume === undefined,
      });
      runtimes.set(info.id, rt);
      // Background tasks a session left listed when Cerium went away without ending it died with it.
      if (options.resume !== undefined) {
        const listed = yield* store
          .listEvents(info.id, { tags: ["BackgroundTasksChanged"] })
          .pipe(Effect.mapError(unavailable));
        const latest = listed.at(-1)?.payload;
        rt.background = latest?._tag === "BackgroundTasksChanged" ? latest.tasks.length : 0;
        yield* clearBackground(rt);
      }

      let resume = options.resume;
      const startFailure = (cause: Cause.Cause<OrchestratorError>) => {
        const error = Cause.squash(cause);
        return error instanceof OrchestratorError
          ? error
          : new OrchestratorError({
              reason: "unavailable",
              message: error instanceof Error ? error.message : String(error),
            });
      };
      const start = Effect.gen(function* () {
        const info = rt.info;
        const sessionScope = yield* Scope.fork(scope);
        rt.sessionScope = sessionScope;
        return yield* Effect.gen(function* () {
          const { advisor } = yield* settings.get;
          if (rt.instructions === undefined) {
            const previous =
              options.resume === undefined
                ? []
                : yield* store
                    .listEvents(info.id, { tags: ["SessionStarted"] })
                    .pipe(Effect.mapError(unavailable));
            const saved = previous.findLast(
              (e) =>
                e.payload._tag === "SessionStarted" &&
                e.payload.ceriumInstructions !== undefined &&
                e.payload.ceriumPromptVersion === PROMPT_VERSION,
            );
            rt.instructions =
              saved?.payload._tag === "SessionStarted" ? saved.payload.ceriumInstructions : undefined;
            rt.instructions ??= systemPrompt(info, bus.serverName, {
              advisor: advisor.enabled && advisor.model !== undefined,
              neighbours: yield* neighboursOf(info, cwd),
              worktree: threadWorktrees.get(info.threadId),
            });
          }
          const busSpec = yield* bus.register(info.id, info.parentId === undefined ? "lead" : "child");
          yield* Scope.addFinalizer(sessionScope, bus.unregister(info.id));
          const session = yield* adapter
            .startSession({
              cwd,
              model: info.model,
              ...(info.effort ? { effort: info.effort } : {}),
              ...(info.speed ? { speed: info.speed } : {}),
              ...(resume === undefined ? {} : { resume }),
              access: info.access,
              mcpServers: isHelper(info) ? {} : { [bus.serverName]: busSpec },
              includeUserMcpServers:
                !isHelper(info) && (info.parentId === undefined || options.includeUserMcpServers === true),
              trustedMcpServers: [bus.serverName],
              appendSystemPrompt: rt.instructions,
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
              Effect.mapError(unavailable),
            );
          rt.sessionExpiresAt =
            (yield* Clock.currentTimeMillis) + Duration.toMillis(config.warmSessionMaxAge);
          rt.session = session;
          yield* Effect.forkIn(consumeEvents(rt, session), sessionScope);
          yield* Deferred.succeed(rt.started, session);
        }).pipe(
          Effect.onError(() =>
            Scope.close(sessionScope, Exit.void).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  rt.sessionScope = undefined;
                  rt.session = undefined;
                  rt.sessionExpiresAt = undefined;
                }),
              ),
            ),
          ),
        );
      });
      rt.wakeSession = rt.sessionPermit.withPermits(1)(
        Effect.gen(function* () {
          rt.touchedAt = yield* Clock.currentTimeMillis;
          if (!rt.sleeping || rt.ended) return;
          rt.sleeping = false;
          rt.started = yield* Deferred.make<AgentSession, OrchestratorError>();
          // A session put to sleep before it took a turn holds nothing, and its harness may never
          // have saved it (Codex keeps a thread only once it runs a turn): a new one takes its place.
          resume = rt.fresh ? undefined : rt.info.providerSessionId;
          yield* start.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                rt.sleeping = true;
                yield* Deferred.fail(rt.started, startFailure(cause));
                if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt;
              }),
            ),
            Effect.asVoid,
          );
        }),
      );
      const prepared = yield* Deferred.make<void, OrchestratorError>();
      yield* Effect.forkIn(
        (options.prepare ?? Effect.void).pipe(
          Deferred.into(prepared),
          Effect.andThen(Deferred.await(prepared)),
          Effect.andThen(start),
          Effect.catchCause((cause) => {
            const error = startFailure(cause);
            if (Cause.hasInterrupts(cause)) {
              return Deferred.fail(rt.started, error).pipe(Effect.andThen(Effect.interrupt));
            }
            return Effect.gen(function* () {
              rt.ended = true;
              yield* emit(rt, {
                _tag: "AgentError",
                kind: "unknown",
                message: error.message,
                retryable: false,
              });
              yield* setState(rt, "failed");
              const assignment = messageDelivery.taskFor(info.id);
              messageDelivery.remove(info.id);
              if (assignment !== undefined) {
                yield* deliver(assignment.from, {
                  _tag: "SystemNotice",
                  text: `Agent ${info.id} (${info.role}) could not start: ${error.message}. Completed sibling results are included with this notice.`,
                });
              }
            }).pipe(Effect.ensuring(Deferred.fail(rt.started, error)), Effect.ignore);
          }),
        ),
        scope,
      );
      // A folder's first snapshot reads every file in it; taken now, the first turn's is quick.
      if (savesFiles(info)) {
        yield* Effect.forkIn(
          Deferred.await(prepared).pipe(Effect.andThen(snapshotFor(info)), Effect.ignore),
          scope,
        );
      }
      yield* Effect.forkIn(turnLoop(rt), scope);
      if (options.initial !== undefined) yield* Queue.offer(rt.inbox, options.initial);
      return rt;
    });

  /**
   * Starts a stopped or failed lead again on its harness session, so the thread carries on with
   * the context it had; a lead whose session never started gets a new one, as does one a rewind
   * left without a session. Returns the user's messages the old runtime never delivered (after
   * the conversation a replaying rewind tells), and notices the lead's next turn should carry.
   */
  const resumeLead = Effect.fn("Orchestrator.resumeLead")(function* (agentId: AgentId) {
    const previous = runtimes.get(agentId);
    const info = yield* agentInfo(agentId);
    if (info.parentId !== undefined) {
      return yield* notAllowed(`${info.model} has stopped; only a thread's lead can be resumed.`);
    }
    const adapter = adapters.get(info.provider);
    if (info.providerSessionId !== undefined && adapter !== undefined && !adapter.manifest.session.resume) {
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
      return yield* notAllowed("This thread's worktree was removed when it was archived; restore it first.");
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
    const heldMessages = new Map<string, InputItem>();
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
      if (payload._tag === "NoticeHeld")
        heldMessages.set(payload.id, { _tag: "SystemNotice", id: payload.id, text: payload.text });
      if (payload._tag === "MessageHeld" && payload.message.id !== undefined) {
        heldMessages.set(payload.message.id, payload.message);
      }
      if (payload._tag === "TurnInput") {
        for (const item of payload.items) {
          if (item._tag === "FromUser" && item.id) undelivered.delete(item.id);
          if ((item._tag === "FromAgent" || item._tag === "SystemNotice") && item.id)
            heldMessages.delete(item.id);
        }
      }
      // Every message queued before a rewind went with the turns it replaced.
      if (payload._tag === "ConversationRewound") undelivered.clear();
    }
    // Forgotten before the new session can be reached, so a late answer finds nothing to allow.
    for (const requestId of unansweredSpawns.keys()) pendingSpawns.delete(requestId);
    if (heldMessages.size > 0) heldNotices.set(agentId, [...heldMessages.values()]);
    const rt = yield* startRuntime(info, directory, {
      ...(info.providerSessionId === undefined || startsAnew(history)
        ? {}
        : { resume: info.providerSessionId }),
      ...(thread.worktree === undefined
        ? {}
        : { prepare: ensureWorktree(thread.id, thread.worktree, directory) }),
    });
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
        agent.parentId === agentId && spawned.has(agent.id) && !isHelper(agent) && !runtimes.has(agent.id),
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
      ([requestId]) => unansweredQuestions.has(requestId) || (expiredAt.get(requestId) ?? -1) > lastTurnAt,
    );
    if (unheard.length > 0) {
      notices.push({
        _tag: "SystemNotice",
        text: `Your session ended before the user answered ${unheard
          .map(([, [{ question }]]) => `"${question.length > 120 ? `${question.slice(0, 119)}…` : question}"`)
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

  const childIdleTTL = Duration.toMillis(config.childIdleTTL);
  const idleTTL = Duration.toMillis(config.idleSessionTTL);
  const isIdleHost = (rt: Runtime) =>
    !rt.ended &&
    !rt.sleeping &&
    rt.info.state === "idle" &&
    rt.sessionExpiresAt !== undefined &&
    Deferred.isDoneUnsafe(rt.started) &&
    rt.info.providerSessionId !== undefined &&
    adapters.get(rt.info.provider)?.manifest.session.resume === true;
  const hostIsDue = (rt: Runtime, warm: boolean, now: number) =>
    (rt.sessionExpiresAt !== undefined && now >= rt.sessionExpiresAt) ||
    (!warm && now - rt.touchedAt >= idleTTL);

  // Keep the latest idle hosts warm until their own deadlines. Only the session scope closes:
  // the inbox and turn loop remain reachable, so a delayed report or message wakes the agent.
  const retireIdleSessions = Effect.gen(function* () {
    const idle = [...runtimes.values()]
      .filter((rt) => (rt.info.parentId === undefined || isHelper(rt.info)) && isIdleHost(rt))
      .sort((a, b) => b.touchedAt - a.touchedAt);
    const checkedAt = yield* Clock.currentTimeMillis;
    for (const child of [...runtimes.values()]) {
      if (!isFreeChild(child)) continue;
      const parent = child.info.parentId === undefined ? undefined : runtimes.get(child.info.parentId);
      const idleSince = Math.max(child.touchedAt, parent?.touchedAt ?? 0);
      if (
        checkedAt - idleSince >= childIdleTTL &&
        !working(child.info.threadId) &&
        !waitsOnUser(child.info.threadId)
      ) {
        yield* stopRuntime(child);
      }
    }
    let warmLeads = 0;
    for (const rt of idle) {
      const warm = rt.info.parentId === undefined && warmLeads++ < config.warmSessions;
      if (!hostIsDue(rt, warm, checkedAt)) continue;
      yield* rt.sessionPermit.withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // A compaction may already hold the turn permit before it changes the agent's state.
          const scope = yield* rt.turnPermit.withPermitsIfAvailable(1)(
            Effect.sync(() => {
              const sessionScope = rt.sessionScope;
              if (
                sessionScope === undefined ||
                !isIdleHost(rt) ||
                !hostIsDue(rt, warm, now) ||
                rt.turn !== undefined ||
                rt.preparingTurn ||
                Queue.sizeUnsafe(rt.inbox) > 0 ||
                waitsOnUser(rt.info.threadId) ||
                working(rt.info.threadId) ||
                rt.openCalls.size > 0 ||
                // Closing the session would end the work it runs in the background.
                rt.background > 0
              )
                return;
              rt.sleeping = true;
              return sessionScope;
            }),
          );
          const sessionScope = Option.getOrUndefined(scope);
          if (sessionScope === undefined) return;
          yield* Scope.close(sessionScope, Exit.void).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                rt.session = undefined;
                rt.started = yield* Deferred.make<AgentSession, OrchestratorError>();
                rt.sessionScope = undefined;
                rt.sessionExpiresAt = undefined;
                rt.storedRaw = undefined;
              }),
            ),
          );
        }),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Couldn't retire idle sessions", cause)),
    Effect.delay(
      Math.max(
        10,
        Math.min(60_000, childIdleTTL / 5, idleTTL / 5, Duration.toMillis(config.warmSessionMaxAge) / 5),
      ),
    ),
    Effect.forever,
  );

  return {
    startRuntime,
    resumeLead,
    liveLead,
    retireIdleSessions,
  };
};

export type AgentSessions = ReturnType<typeof makeAgentSessions>;
