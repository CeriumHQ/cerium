import {
  LEAD_ROLE,
  MAX_THREAD_TITLE,
  narrowAccess,
  type AgentEvent,
  type AgentId,
  type AgentInfo,
  type EventId,
  type EventPayload,
  type ThreadId,
  type ThreadInfo,
  type ThreadWorktree,
} from "@cerium/protocol";
import { Deferred, Effect, Option } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import {
  noAdapter,
  notAllowed,
  notFound,
  OrchestratorError,
  refusedWorktree,
  unavailable,
} from "./errors.ts";
import type { Inbox } from "./inbox.ts";
import type { AssistantThreadRequest, CreateThreadInput, ForkThreadInput, ThreadRequest } from "./inputs.ts";
import { defaultAssistantModel } from "./inputs.ts";
import { resolveTarget, type SpawnTarget } from "./runtime.ts";
import { offeredModels, type NewWorktree } from "./services.ts";
import { FORK_TAGS, threadForkPoint } from "./threadFork.ts";
import type { ThreadWorkspace } from "./threadWorkspace.ts";

/**
 * Starting threads: the user's, a fork of one at a turn, one that continues another, and those a lead
 * or an assistant outside Cerium starts for the user.
 */
export const makeThreadCreation = (
  ctx: OrchestratorContext,
  sessions: AgentSessions,
  workspace: ThreadWorkspace,
  inbox: Inbox,
) => {
  const {
    store,
    adapters,
    catalog,
    config,
    routerOn,
    worktrees,
    checkpoints,
    fs,
    path,
    runtimes,
    threadDirectories,
    threadModes,
    threadWorktrees,
    checkouts,
    untitled,
    briefsOwed,
    inThread,
    makeId,
    runtime,
    now,
    waitsOnUser,
    working,
    updateThread,
    spend,
    threadInfo,
    threadDirectory,
    stopThreadAgents,
  } = ctx;
  const { startRuntime } = sessions;
  const { ensureWorktree, makeWorktree } = workspace;
  const { acceptUserMessage } = inbox;

  /** With `adopted`, the thread takes over that worktree, which `cwd` is in, instead of making one. */
  const createThread = Effect.fn("Orchestrator.createThread")(function* (
    input: CreateThreadInput,
    adopted?: ThreadWorktree,
  ) {
    if (input.mode === "work" && input.cwd === undefined) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: "A work thread needs a folder.",
      });
    }
    const createdAt = yield* now;
    const threadId = (yield* makeId("thr")) as ThreadId;
    const source =
      input.workspace?.sourceThreadId === undefined
        ? undefined
        : yield* threadInfo(input.workspace.sourceThreadId as ThreadId);
    if (source !== undefined && source.worktree === undefined)
      return yield* notAllowed(
        "The source thread needs a branch workspace before another task can build on it.",
      );
    const choice =
      source === undefined
        ? input.workspace
        : { ...input.workspace, baseRef: input.workspace?.baseRef ?? source.worktree!.branch };
    // Only picked here: the checkout runs behind the thread, so it shows at once.
    let isolated: NewWorktree | undefined =
      adopted === undefined &&
      input.mode === "work" &&
      input.cwd !== undefined &&
      (input.worktree === true || input.workspace !== undefined)
        ? yield* worktrees.plan(input.cwd, input.title, choice).pipe(Effect.mapError(refusedWorktree))
        : undefined;
    if (isolated !== undefined && input.workspace?.path !== undefined) {
      const selected = isolated;
      const identity = (root: string) =>
        process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
      const previous = (yield* store.listThreads.pipe(Effect.mapError(unavailable))).find(
        (other) =>
          other.worktree !== undefined && identity(other.worktree.root) === identity(selected.worktree.root),
      )?.worktree;
      if (previous)
        isolated = {
          ...selected,
          worktree: {
            ...previous,
            id: selected.worktree.id!,
            project: selected.worktree.project,
            root: selected.worktree.root,
            branch: selected.worktree.branch,
          },
        };
    }
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
      ...(isolated
        ? {
            worktree: {
              ...isolated.worktree,
              ...(source === undefined ? {} : { dependsOnThreadId: source.id }),
            },
          }
        : adopted
          ? { worktree: adopted }
          : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.onLimit ? { onLimit: input.onLimit } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    if (input.mode === "chat") {
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unavailable));
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
    );
    threadDirectories.set(threadId, directory);
    threadModes.set(threadId, input.mode);
    // A thread that continues another keeps its title.
    if (adopted === undefined) untitled.set(threadId, input.title);
    if (adopted !== undefined) {
      threadWorktrees.set(threadId, adopted);
      yield* startRuntime(lead, directory, { prepare: ensureWorktree(threadId, adopted, directory) });
      return { thread, lead };
    }
    if (isolated === undefined) {
      yield* startRuntime(lead, directory);
      return { thread, lead };
    }
    threadWorktrees.set(threadId, isolated.worktree);
    if (input.workspace?.path !== undefined) {
      yield* startRuntime(lead, directory, {
        prepare: ensureWorktree(threadId, isolated.worktree, directory),
      });
      return { thread, lead };
    }
    const checkedOut = yield* Deferred.make<void, OrchestratorError>();
    checkouts.set(threadId, checkedOut);
    yield* startRuntime(lead, directory, {
      prepare: makeWorktree(threadId, lead.id, isolated).pipe(
        Deferred.into(checkedOut),
        Effect.andThen(Deferred.await(checkedOut)),
        Effect.ensuring(Effect.sync(() => checkouts.delete(threadId))),
      ),
    });
    return { thread, lead };
  });

  const findForkPoint = Effect.fn("Orchestrator.findForkPoint")(function* ({
    threadId,
    turn,
  }: Pick<ForkThreadInput, "threadId" | "turn">) {
    const source = yield* threadInfo(threadId);
    const agents = yield* store.listAgents(threadId).pipe(Effect.mapError(unavailable));
    const original = agents.find((agent) => agent.role === LEAD_ROLE && agent.parentId === undefined);
    if (original === undefined) return yield* notFound("This thread has no lead to fork.");
    const events = yield* store
      .listEvents(original.id, { tags: FORK_TAGS })
      .pipe(Effect.mapError(unavailable));
    const cwd = threadDirectory(source);
    const point = threadForkPoint(events, turn, cwd, original);
    if (point === undefined) return yield* notFound("That turn is no longer in the conversation.");
    if (
      !point.completed &&
      point.turnId !== undefined &&
      runtimes.get(original.id)?.currentTurnId === point.turnId
    ) {
      return yield* notAllowed("Wait for this turn to finish, then try again.");
    }
    return { source, original, point, cwd };
  });

  const forkThread = Effect.fn("Orchestrator.forkThread")(function* (input: ForkThreadInput) {
    const { source, original, point, cwd } = yield* inThread(input.threadId)(findForkPoint(input));
    const provider = input.harness ?? original.provider;
    const adapter = adapters.get(provider);
    if (adapter === undefined) {
      return yield* noAdapter(provider);
    }
    const model =
      input.model ??
      (provider === original.provider
        ? original.model
        : (yield* offeredModels(catalog)).find((choice) => choice.provider === provider)?.model);
    if (model === undefined) return yield* notAllowed("Choose a model for the fork's harness.");

    let sessionId: string | undefined;
    if (
      source.mode === "work" &&
      input.workspace !== "worktree" &&
      provider === original.provider &&
      point.nativeTurn !== undefined &&
      original.providerSessionId !== undefined &&
      adapter.manifest.session.fork &&
      adapter.manifest.session.resume &&
      adapter.fork !== undefined &&
      (yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))
    ) {
      sessionId = yield* adapter
        .fork({ cwd, sessionId: original.providerSessionId, through: point.nativeTurn })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning(`Couldn't fork ${provider} session: ${error.message}`),
          ),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        );
    }

    const createdAt = yield* now;
    const threadId = (yield* makeId("thr")) as ThreadId;
    const leadId = (yield* makeId("agt")) as AgentId;
    const title = `Fork of ${source.title}`.slice(0, MAX_THREAD_TITLE);
    const isolated = input.workspace === "worktree";
    const snapshot = point.snapshot;
    if (isolated && (source.mode !== "work" || snapshot?.folder === undefined)) {
      return yield* notAllowed("This turn has no file snapshot for a new worktree.");
    }
    const planned = isolated
      ? yield* worktrees.plan(source.worktree?.project ?? cwd, title).pipe(Effect.mapError(refusedWorktree))
      : undefined;
    const directory =
      planned?.cwd ?? (source.mode === "chat" ? path.join(config.chatDirectory, threadId) : cwd);
    if (
      !isolated &&
      source.mode === "work" &&
      !(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* notAllowed(
        "This workspace is unavailable. Choose a new worktree to use the turn's snapshot.",
      );
    }
    const thread: ThreadInfo = {
      id: threadId,
      title,
      mode: source.mode,
      ...(source.mode === "work" ? { cwd: directory } : {}),
      ...(planned === undefined ? {} : { worktree: planned.worktree }),
      forkedFrom: { threadId: source.id, turn: point.turn },
      ...(source.onLimit === undefined ? {} : { onLimit: source.onLimit }),
      createdAt,
      updatedAt: createdAt,
    };
    const keptModel = provider === original.provider && model === original.model;
    const lead: AgentInfo = {
      id: leadId,
      threadId,
      role: LEAD_ROLE,
      provider,
      model,
      ...(keptModel && original.effort ? { effort: original.effort } : {}),
      ...(keptModel && original.autoEffort ? { autoEffort: true } : {}),
      ...(keptModel && original.speed ? { speed: original.speed } : {}),
      ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
      access: original.access,
      state: "idle",
      createdAt,
      updatedAt: createdAt,
    };
    const history = point.history;
    const context: Extract<EventPayload, { _tag: "ForkContext" }> = {
      _tag: "ForkContext",
      from: point.from,
    };
    if (sessionId === undefined) history.push({ at: createdAt, payload: context });
    else if (point.inheritedBoundary !== undefined) {
      const boundary = point.inheritedBoundary;
      history.splice(boundary, 0, { at: history[boundary]?.at ?? createdAt, payload: context });
    }
    const seed = history.map(({ at, payload }, sequence): AgentEvent => ({
      id: `${leadId}:${sequence}` as EventId,
      threadId,
      agentId: leadId,
      sequence,
      at,
      payload,
    }));
    const makeDirectory = fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unavailable));
    yield* Effect.gen(function* () {
      if (planned !== undefined && snapshot?.folder !== undefined) {
        yield* worktrees
          .checkOut(planned.worktree, { copyIgnored: false })
          .pipe(Effect.mapError(refusedWorktree));
        // The base revision may hold a symlink where the source turn had a folder.
        // Walk below the new checkout before writing anything at that location.
        const prefix = path.relative(planned.worktree.root, directory);
        const realPath = (folder: string) => fs.realPath(folder).pipe(Effect.mapError(unavailable));
        let folder = yield* realPath(planned.worktree.root);
        for (const segment of prefix.split(path.sep).filter(Boolean)) {
          folder = path.join(folder, segment);
          const entry = yield* fs.stat(folder).pipe(Effect.option);
          if (
            Option.isSome(entry) &&
            (entry.value.type !== "Directory" || (yield* realPath(folder)) !== folder)
          ) {
            return yield* notAllowed("The selected project folder isn't a directory in the new worktree.");
          }
          if (Option.isNone(entry)) {
            yield* fs.makeDirectory(folder).pipe(Effect.mapError(unavailable));
          }
        }
        yield* checkpoints
          .restoreInto(snapshot.folder, snapshot.snapshot, directory)
          .pipe(Effect.mapError(unavailable));
      } else if (source.mode === "chat") yield* makeDirectory;
      yield* store.createThread(thread, { lead, history: seed }).pipe(Effect.mapError(unavailable));
    }).pipe(
      Effect.onError(() =>
        planned === undefined
          ? Effect.void
          : worktrees.remove(threadId, planned.worktree).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(`Couldn't remove the unfinished fork worktree: ${error.message}`),
              ),
              Effect.ignore,
            ),
      ),
      Effect.uninterruptible,
    );

    threadDirectories.set(threadId, directory);
    threadModes.set(threadId, thread.mode);
    if (planned !== undefined) threadWorktrees.set(threadId, planned.worktree);
    if (sessionId === undefined) briefsOwed.set(leadId, context);
    yield* startRuntime(lead, directory, sessionId === undefined ? {} : { resume: sessionId });
    return { thread, lead };
  });

  const previewForkThread = (input: Pick<ForkThreadInput, "threadId" | "turn">) =>
    findForkPoint(input).pipe(Effect.map(({ point }) => ({ snapshot: point.snapshot !== undefined })));

  const continueThread = Effect.fn("Orchestrator.continueThread")(function* (threadId: ThreadId) {
    if (working(threadId) || waitsOnUser(threadId)) {
      return yield* notAllowed("A thread can't be continued while its agents are working or waiting on you.");
    }
    const thread = yield* threadInfo(threadId);
    if (thread.archivedAt !== undefined) {
      return yield* notAllowed("Restore this thread before continuing it.");
    }
    const lead = (yield* store.listAgents(threadId).pipe(Effect.mapError(unavailable))).find(
      (agent) => agent.parentId === undefined && agent.role === LEAD_ROLE,
    );
    if (lead === undefined) return yield* notFound(`Thread ${threadId} has no lead.`);
    // A checkout still under way finishes first, so the worktree passes on whole.
    const making = checkouts.get(threadId);
    if (making !== undefined) yield* Effect.exit(Deferred.await(making));
    const started = yield* createThread(
      {
        title: thread.title,
        mode: thread.mode,
        ...(thread.cwd === undefined ? {} : { cwd: thread.cwd }),
        ...(thread.onLimit === undefined ? {} : { onLimit: thread.onLimit }),
        lead: {
          provider: lead.provider,
          model: lead.model,
          ...(lead.effort ? { effort: lead.effort } : {}),
          ...(lead.autoEffort ? { autoEffort: true } : {}),
          ...(lead.speed ? { speed: lead.speed } : {}),
          access: lead.access,
        },
      },
      thread.worktree,
    );
    // The old thread's sessions end, and it lets go of the worktree its successor now holds.
    yield* stopThreadAgents(threadId);
    threadWorktrees.delete(threadId);
    yield* updateThread(threadId, {
      archivedAt: yield* now,
      laterUntil: null,
      ...(thread.worktree === undefined || thread.worktree.id !== undefined ? {} : { worktree: null }),
    });
    return started;
  });

  const startThread = Effect.fn("Orchestrator.startThread")(function* (
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
      ...((request.effort ?? caller.info.effort) ? { effort: request.effort ?? caller.info.effort } : {}),
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
      return yield* noAdapter(target.provider);
    }
    const origin = yield* threadInfo(caller.info.threadId);
    yield* spend(
      "threads",
      config.threadBudget,
      (recent) =>
        `Agents have started ${recent} threads recently, the most allowed. Ask the user to start the rest.`,
    );
    // A thread in a worktree starts from the project, not from the worktree's folder.
    // A chat lead that specifies `folder` starts a work thread in that project.
    const requestedFolder = request.folder?.trim() || undefined;
    const folder = requestedFolder ?? origin.worktree?.project ?? origin.cwd;
    const targetMode = requestedFolder !== undefined ? "work" : origin.mode;
    const targetAccess =
      origin.mode === "chat" && targetMode === "work"
        ? (request.access ?? "ask")
        : narrowAccess(caller.info.access, request.access ?? caller.info.access);
    const started = yield* createThread({
      title: title ?? (targetMode === "work" ? "New thread" : "New chat"),
      mode: targetMode,
      ...(folder !== undefined ? { cwd: folder } : {}),
      worktree: request.worktree ?? (targetMode === "work" && origin.worktree !== undefined),
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
      lead: {
        ...target,
        // A new lead starts on Auto while the router is on, unless the caller named an effort.
        ...(request.effort === undefined && (yield* routerOn) ? { autoEffort: true } : {}),
        access: targetAccess,
      },
    });
    if (title !== undefined) untitled.delete(started.thread.id);
    yield* acceptUserMessage(started.lead.id, request.prompt, {
      writtenBy: { agentId: callerId, threadId: origin.id, threadTitle: origin.title },
    });
    return started;
  });

  const startAssistantThread = Effect.fn("Orchestrator.startAssistantThread")(function* (
    request: AssistantThreadRequest,
  ) {
    const title = request.title?.trim() || undefined;
    if (title !== undefined && title.length > MAX_THREAD_TITLE) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `A title is 1 to ${MAX_THREAD_TITLE} characters; leave it out to have the thread named from its prompt.`,
      });
    }
    const entries = yield* catalog.entries;
    const first = defaultAssistantModel(entries);
    const target =
      request.model === undefined
        ? first === undefined
          ? undefined
          : resolveTarget(entries, { model: first.alias })
        : resolveTarget(entries, { model: request.model });
    if (target === undefined) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message:
          request.model === undefined
            ? "No harness is signed in on this computer, so no thread can start there."
            : `"${request.model}" isn't a model this computer offers. list_models names the ones it does.`,
      });
    }
    if (!adapters.has(target.provider)) {
      return yield* noAdapter(target.provider);
    }
    yield* spend(
      "assistants",
      config.threadBudget,
      (recent) =>
        `Assistants have started ${recent} threads on this computer recently, the most allowed. Try again later.`,
    );
    const work = request.cwd !== undefined;
    const started = yield* createThread({
      title: title ?? (work ? "New thread" : "New chat"),
      mode: work ? "work" : "chat",
      ...(work ? { cwd: request.cwd } : {}),
      worktree: work && request.worktree === true,
      lead: {
        ...target,
        ...((yield* routerOn) ? { autoEffort: true } : {}),
        access: request.access,
      },
    });
    if (title !== undefined) untitled.delete(started.thread.id);
    yield* acceptUserMessage(started.lead.id, request.prompt, {
      sentVia: { assistant: request.assistant },
    });
    return started;
  });

  return {
    createThread,
    previewForkThread,
    forkThread,
    continueThread,
    startThread,
    startAssistantThread,
  };
};
