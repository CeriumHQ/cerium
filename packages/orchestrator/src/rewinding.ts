import {
  applyTurnFileRevert,
  type AgentEvent,
  type AgentId,
  type AgentInfo,
  type EventPayload,
  type RestorePreview,
  type ThreadId,
  type ThreadInfo,
  type TurnFilesReverted,
  type TurnFileState,
} from "@cerium/protocol";
import { Effect, Option } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import { notAllowed, notFound, OrchestratorError, unavailable } from "./errors.ts";
import { planRestore, workSince } from "./restore.ts";
import { REWIND_TAGS, liveEvents, rewindPoint, startsAnew } from "./rewind.ts";

/**
 * Going back: a lead's conversation to before one of the user's messages (rewinding), its thread's
 * files with it (restoring), or the files of one turn (reverting).
 */
export const makeRewinding = (ctx: OrchestratorContext, sessions: AgentSessions) => {
  const {
    store,
    adapters,
    checkpoints,
    path,
    runtimes,
    pendingSpawns,
    held,
    forAgent,
    agentInfo,
    now,
    emit,
    emitStored,
    emitTo,
    threadInfo,
    threadDirectory,
    stopRuntime,
  } = ctx;
  const { resumeLead } = sessions;

  /**
   * Takes a lead's conversation back to before one of the user's messages: the session it goes on
   * in holds only what came before, by its harness's own fork where it has one, else a new session
   * told the conversation so far. The agents the replaced turns spawned stop, and their files stay
   * as they are. Resolves with the message it went back before.
   */
  const rewind = Effect.fn("Orchestrator.rewind")(function* (
    agentId: AgentId,
    messageId: string,
    history?: ReadonlyArray<AgentEvent>,
  ) {
    const live = runtimes.get(agentId);
    const stored = yield* agentInfo(agentId);
    if (stored.parentId !== undefined) {
      return yield* notAllowed("Only the conversation with a thread's lead can go back.");
    }
    const thread = Option.getOrUndefined(
      yield* store.getThread(stored.threadId).pipe(Effect.mapError(unavailable)),
    );
    if (thread === undefined) return yield* notFound(`Thread ${stored.threadId} does not exist.`);
    const added = yield* store
      .listEvents(agentId, {
        tags: REWIND_TAGS,
        ...(history === undefined ? {} : { afterSequence: history.at(-1)?.sequence ?? -1 }),
      })
      .pipe(Effect.mapError(unavailable));
    const events = history === undefined ? added : [...history, ...added];
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
                Effect.logWarning(`Couldn't fork ${info.provider} session ${sessionId}: ${error.message}`),
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

  /**
   * Where restoring a lead's thread to before one of the user's messages goes back to: the turn
   * that delivered it, when that turn began, and the snapshot of the folder taken just before it.
   */
  const restorePoint = Effect.fn("Orchestrator.restorePoint")(function* (
    agentId: AgentId,
    messageId: string,
  ) {
    const lead = yield* agentInfo(agentId);
    if (lead.parentId !== undefined) {
      return yield* notAllowed("Only a thread's lead can go back to before one of your messages.");
    }
    const thread = yield* threadInfo(lead.threadId);
    const events = yield* store.listEvents(agentId, { tags: REWIND_TAGS }).pipe(Effect.mapError(unavailable));
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
      Effect.catchTag("CheckpointError", (error) => Effect.succeed({ unavailable: error.message } as const)),
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
    const { thread, since, snapshot, events } = yield* restorePoint(agentId, messageId);
    // Every agent stops before a file goes back, so none changes one meanwhile; the lead's
    // conversation then goes back, and it hears the agents it spawned are gone.
    yield* Effect.forEach(liveChildren(thread.id), stopRuntime, { discard: true });
    const message = yield* rewind(agentId, messageId, events);
    const plan = yield* filePlan(thread, since, snapshot);
    if (snapshot === undefined || plan === undefined || !("restored" in plan) || plan.restored.length === 0) {
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
    paths?: ReadonlyArray<string>,
  ) {
    const rt = runtimes.get(agentId);
    const info = yield* agentInfo(agentId);
    const thread = yield* threadInfo(info.threadId);
    const events = yield* store
      .listEvents(agentId, { tags: ["TurnFilesChanged", "TurnFilesReverted"] })
      .pipe(Effect.mapError(unavailable));
    let changed: Extract<EventPayload, { _tag: "TurnFilesChanged" }> | undefined;
    let state: ReadonlyMap<string, TurnFileState> | undefined;
    for (const { payload } of events) {
      if (payload._tag !== "TurnFilesChanged" && payload._tag !== "TurnFilesReverted") continue;
      if (payload.turnId !== turnId) continue;
      if (payload._tag === "TurnFilesChanged") {
        changed = payload;
        state = undefined;
      } else state = applyTurnFileRevert(state, payload);
    }
    if (changed === undefined || thread.mode !== "work") {
      return yield* notFound("That turn changed no files Cerium knows of.");
    }
    const turnPaths = changed.files.map((file) => file.path);
    if (paths !== undefined && (paths.length === 0 || paths.some((file) => !turnPaths.includes(file)))) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: "Choose one or more files changed in that turn.",
      });
    }
    const requested = paths === undefined ? undefined : new Set(paths);
    const wanted = direction === "undone";
    const candidates = turnPaths.filter((file) => {
      const current = state?.get(file);
      return requested === undefined
        ? (current?.turnUndone ?? false) !== wanted
        : requested.has(file) && (current?.undone ?? false) !== wanted;
    });
    if (candidates.length === 0) {
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
      (yield* checkpoints.changes(folder, expected, now, candidates).pipe(Effect.mapError(failed))).map(
        (file) => file.path,
      ),
    );
    const back = candidates.filter((file) => !since.has(file));
    const blocked = yield* checkpoints
      .restore(folder, target, back, { protectOtherPaths: true })
      .pipe(Effect.mapError(failed));
    for (const file of blocked) since.add(file);
    const payload: TurnFilesReverted = {
      _tag: "TurnFilesReverted",
      turnId,
      direction,
      paths: back.filter((file) => !since.has(file)),
      kept: candidates.filter((file) => since.has(file)),
      ...(requested === undefined ? {} : { partial: true }),
    };
    yield* emitTo(info, rt, payload);
    return payload;
  });

  return {
    rewind,
    rewindLead: (agentId: AgentId, messageId: string) => forAgent(agentId)(rewind(agentId, messageId)),
    previewRestore,
    restoreBefore: (agentId: AgentId, messageId: string) =>
      forAgent(agentId, true)(restoreBefore(agentId, messageId)),
    // One at a time, and never beside a restore: each reads the files the other puts back.
    revertTurn: (
      agentId: AgentId,
      turnId: string,
      direction: "undone" | "redone",
      paths?: ReadonlyArray<string>,
    ) => forAgent(agentId, true)(revertTurn(agentId, turnId, direction, paths)),
  };
};

export type Rewinding = ReturnType<typeof makeRewinding>;
