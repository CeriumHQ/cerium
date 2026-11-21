import type { AgentSession, HarnessFailure, TurnExtras, TurnImage } from "@cerium/harness";
import type {
  AgentInfo,
  Attachment,
  EventPayload,
  FromAgent,
  InputItem,
  LimitReached,
} from "@cerium/protocol";
import { Clock, Deferred, Effect, Option, Queue, Stream } from "effect";
import { Base64 } from "effect/encoding";

import type { OrchestratorContext } from "./context.ts";
import { RECENT_EXCHANGES } from "./effort.ts";
import { OrchestratorError, unavailable } from "./errors.ts";
import { handoffBrief, olderTurns } from "./handoff.ts";
import type { ModelChoice } from "./inputs.ts";
import { PROMPT_VERSION, renderTurn, truncate } from "./prompts.ts";
import { liveEvents } from "./rewind.ts";
import { choiceOf, finishTurn, isHelper, type Runtime } from "./runtime.ts";
import { turnFiles, type TurnWork } from "./turnFiles.ts";
import { approvesItself, type UserRequests } from "./userRequests.ts";

const isImage = (attachment: Attachment) => attachment.mediaType.startsWith("image/");

/** What a handoff's brief reads of the lead's history: its conversation, files and plan. */
const BRIEF_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "TurnInput",
  "MessageCompleted",
  // What a turn cut off by a limit had done.
  "ToolCallStarted",
  "LimitReached",
  "ConversationRewound",
  "LeadHandedOff",
  "WorkspaceMoved",
  "TurnFilesChanged",
  "FileChanged",
  "TodosUpdated",
];

/** What the turn loop calls out to: the effort router before a turn, and limit handling after one. */
export interface TurnHooks {
  /** On Auto, the effort router picks the effort of the turn about to start. */
  readonly routeEffort: (
    rt: Runtime,
    items: readonly [InputItem, ...Array<InputItem>],
  ) => Effect.Effect<void>;
  /** What the thread does about its lead's turn ending at its harness's limit. */
  readonly handleLimit: (rt: Runtime, hit: LimitReached) => Effect.Effect<void>;
}

/**
 * An agent's turns: reading its session's events, running each turn from its inbox, compacting, and
 * what a turn's end hands on (a child's result to its lead, an advisor's answer, a review).
 */
export const makeTurns = (ctx: OrchestratorContext, requests: UserRequests, hooks: TurnHooks) => {
  const {
    store,
    adapters,
    config,
    condenser,
    checkpoints,
    fs,
    crypto,
    layerScope,
    runtimes,
    threadDirectories,
    threadModes,
    pendingPermissions,
    openQuestions,
    messageDelivery,
    advisorQuestions,
    reviews,
    briefsOwed,
    makeId,
    beginWork,
    endWork,
    emit,
    recordModel,
    deliver,
    withHeld,
    holdNotice,
    setState,
    clearBackground,
    expireQuestions,
    childrenOf,
    stopRuntime,
  } = ctx;
  const { askLead, closeLeadRequest, releaseOwnRequests, releaseLeadRequests } = requests;
  const { routeEffort, handleLimit } = hooks;

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
              : event.payload._tag === "SessionStarted"
                ? {
                    ...event.payload,
                    ...(rt.instructions === undefined
                      ? {}
                      : { ceriumInstructions: rt.instructions, ceriumPromptVersion: PROMPT_VERSION }),
                  }
                : event.payload._tag === "UsageReported"
                  ? {
                      ...event.payload,
                      ...(rt.currentTurnId === undefined ? {} : { turnId: rt.currentTurnId }),
                      cause: rt.turnCause,
                      ...(rt.currentRequestId === undefined ? {} : { requestId: rt.currentRequestId }),
                    }
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
          // A reader can act on SessionStarted as soon as it is published.
          if (payload._tag === "SessionStarted")
            rt.info = { ...rt.info, providerSessionId: payload.providerSessionId };
          yield* emit(rt, payload, event.raw);
          if (
            payload._tag === "AgentError" ||
            payload._tag === "LimitReached" ||
            (payload._tag === "TurnCompleted" && payload.stopReason === "error")
          ) {
            rt.turnFailed = true;
          }
          if (payload._tag === "LimitReached") rt.limit ??= payload;
          if (payload._tag === "FileChanged") rt.turnFiles.add(payload.path);
          if (payload._tag === "ToolCallCompleted" && payload.isError) rt.turnToolErrors += 1;
          if (payload._tag === "TurnCompleted") rt.turnStopReason = payload.stopReason;
          switch (payload._tag) {
            case "SessionStarted": {
              const updatedAt = yield* Clock.currentTimeMillis;
              rt.info = { ...rt.info, updatedAt };
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
            case "BackgroundTasksChanged":
              rt.background = payload.tasks.length;
              return;
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
          // The harness's background tasks end with its session.
          yield* clearBackground(rt).pipe(Effect.ignore);
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
            Effect.tapError((error) => Effect.logWarning(`Couldn't snapshot ${folder}: ${error.message}`)),
            Effect.option,
          );
    return Effect.map(saved, Option.getOrUndefined);
  };

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
    initiating: InputItem,
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
      rt.limit = undefined;
      rt.turnFiles.clear();
      const startedAt = yield* Clock.currentTimeMillis;
      rt.turn = yield* Deferred.make<void>();
      const turnId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      rt.currentTurnId = turnId;
      for (const item of items) {
        if (
          item._tag === "FromAgent" &&
          item.kind === "request" &&
          item.agentId === rt.info.parentId &&
          item.requestId !== undefined
        )
          rt.activeAssignments.add(item.requestId);
      }
      rt.currentRequestId = items.flatMap((i) =>
        i._tag === "FromAgent" && i.requestId !== undefined ? [i.requestId] : [],
      )[0];
      rt.turnCause =
        initiating._tag === "FromUser" ||
        (initiating._tag === "SystemNotice" && initiating.questionId !== undefined)
          ? "user"
          : initiating._tag === "ChildFinishedTurn"
            ? "childResult"
            : initiating._tag === "FromAgent"
              ? initiating.kind === "request"
                ? "agentRequest"
                : "agentReply"
              : "notice";
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
      yield* Deferred.await(rt.turn);
      rt.turn = undefined;
      rt.currentTurnId = undefined;
      rt.currentRequestId = undefined;
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
    }).pipe(Effect.ensuring(Effect.asVoid(endWork(rt.info.id))));

  /**
   * A compaction the user asked for: a turn with no input, which the harness's own events report and
   * end. The agent's lead hears nothing of it, as it delivered nothing.
   */
  const compactTurn = (rt: Runtime, compact: Effect.Effect<void, HarnessFailure>) =>
    Effect.gen(function* () {
      rt.turnCause = "compact";
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
    }).pipe(Effect.catchCause((cause) => Effect.logError(`Agent ${rt.info.id} compaction failed`, cause)));

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
            .pipe(Effect.mapError((error) => `Couldn't change the effort to ${effort}: ${error.message}`));
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
            if (now.model === wanted.model && now.effort === wanted.effort && now.speed === wanted.speed) {
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
      const summary = yield* condenser.condense(
        olderTurns(history),
        {
          provider: rt.info.provider,
          model: rt.info.model,
        },
        rt.info.id,
      );
      const running = childrenOf(rt.info.id)
        .filter((child) => !child.ended && !isHelper(child.info))
        .map((child) => child.info);
      const item: InputItem = {
        _tag: "SystemNotice",
        text: handoffBrief(history, {
          from: handoff.from,
          ...(handoff._tag === "ForkContext" ? { forked: true } : { cause: handoff.cause }),
          summary: Option.getOrUndefined(summary),
          running,
        }),
      };
      return item;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning(`Couldn't brief ${rt.info.id} on its conversation`, cause), undefined),
      ),
    );

  /**
   * Delivers inbox items as turns, one turn at a time. Agents never wait for one another's turns
   * to end: a cap on turns at once would leave a messaged thread queued behind other threads' long
   * turns, or behind a child's turn waiting on an answer from the very lead that is queued.
   */
  const turnLoop = (rt: Runtime) =>
    Effect.gen(function* () {
      // A lead paused at its harness's limit takes nothing until the pause is lifted.
      if (rt.pause !== undefined) yield* Deferred.await(rt.pause);
      const first = yield* Queue.take(rt.inbox);
      rt.preparingTurn = true;
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
      rt.preparingTurn = false;
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
      // What was held for it while its session started (a new worktree's setup) comes along.
      const taken = advisor ? items : withHeld(rt.info.id, items);
      const told: readonly [InputItem, ...Array<InputItem>] = brief === undefined ? taken : [brief, ...taken];
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
          yield* runTurn(rt, session, told, first);
        }),
      );
      if (rt.ended) return yield* Effect.interrupt;
      rt.touchedAt = yield* Clock.currentTimeMillis;
      yield* setState(rt, "idle");
      const halted = rt.halted;
      rt.halted = false;

      // The turn ran into its harness's limit: the thread waits, moves on, or stops, as chosen.
      const limit = rt.limit;
      rt.limit = undefined;
      if (limit !== undefined && !halted && rt.info.parentId === undefined) {
        yield* handleLimit(rt, limit);
      }

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
        const assignments = messageDelivery.activeTasks(rt.info.id, rt.activeAssignments);
        const assignment = assignments[0];
        for (const id of rt.activeAssignments)
          if (!messageDelivery.requests.has(id)) rt.activeAssignments.delete(id);
        // A child waiting for an answer has not finished its assignment. Explicit replies
        // already delivered a result, so no second automatic report follows them.
        if (
          assignment === undefined ||
          ((messageDelivery.waiting(rt.info.id) || (openQuestions.get(rt.info.id)?.size ?? 0) > 0) &&
            !rt.turnFailed &&
            limit === undefined)
        )
          return;
        for (const task of assignments) {
          messageDelivery.answer(rt.info.id, task.from, task.id);
          rt.activeAssignments.delete(task.id);
        }
        const text = truncate(
          limit === undefined
            ? (rt.lastMessage ?? "(no final message)")
            : `Stopped early: ${rt.info.model}'s usage limit ran out. ${rt.lastMessage ?? ""}`,
          config.maxDeliveredChars,
        );
        if (!rt.turnFailed && messageDelivery.groupPending(assignment)) {
          const parent = runtimes.get(assignment.from);
          if (parent === undefined || parent.ended) return;
          const message: FromAgent = {
            _tag: "FromAgent",
            id: yield* makeId("msg"),
            agentId: rt.info.id,
            threadId: rt.info.threadId,
            kind: "reply",
            requestId: assignment.id,
            text,
          };
          yield* emit(parent, { _tag: "MessageHeld", message });
          holdNotice(parent.info.id, message);
        } else {
          yield* deliver(assignment.from, {
            _tag: "ChildFinishedTurn",
            requestId: assignment.id,
            agentId: rt.info.id,
            role: rt.info.role,
            text,
          });
        }
      }
    }).pipe(
      Effect.catchCause((cause) => {
        rt.preparingTurn = false;
        return Effect.logError(`Agent ${rt.info.id} turn failed`, cause);
      }),
      Effect.forever,
    );

  return {
    steer,
    consumeEvents,
    compactTurn,
    savesFiles,
    snapshotFor,
    turnLoop,
  };
};

export type Turns = ReturnType<typeof makeTurns>;
