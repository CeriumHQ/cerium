import {
  LEAD_ROLE,
  MAX_THREAD_TITLE,
  type AgentInfo,
  type InputItem,
  type LimitPolicy,
  type ThreadId,
  type ThreadInfo,
  type ThreadOverview,
  type WorkspaceChoice,
} from "@cerium/protocol";
import { Effect, Option, Queue } from "effect";

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
import type { MoveChatToWorkInput, PutAwayOptions } from "./inputs.ts";
import { portsNote, setupNote, type ThreadWorkspace } from "./threadWorkspace.ts";

/**
 * A thread once it exists: listing it, moving its conversation to another checkout, renaming,
 * archiving, putting it off, and deleting it.
 */
export const makeThreadLifecycle = (
  ctx: OrchestratorContext,
  sessions: AgentSessions,
  workspace: ThreadWorkspace,
  inbox: Inbox,
) => {
  const {
    store,
    adapters,
    worktrees,
    scripts,
    runtimes,
    threadDirectories,
    threadModes,
    threadWorktrees,
    pendingSpawns,
    pendingPermissions,
    openQuestions,
    held,
    inThread,
    now,
    emitStored,
    holdNotice,
    waitsOnUser,
    working,
    updateThread,
    threadInfo,
    threadDirectory,
    stopThreadAgents,
  } = ctx;
  const { resumeLead } = sessions;
  const { removeWorktree, ensureWorktree, setUp } = workspace;
  const { acceptUserMessage } = inbox;

  const listThreads = store.listThreads.pipe(Effect.mapError(unavailable));

  const moveThread = Effect.fn("Orchestrator.moveThread")(function* (
    threadId: ThreadId,
    choice: WorkspaceChoice,
    options: { readonly carryOn?: boolean } = {},
  ) {
    if (working(threadId) || waitsOnUser(threadId))
      return yield* notAllowed("Finish the current turn before moving this conversation.");
    const thread = yield* threadInfo(threadId);
    if (thread.mode !== "work" || !thread.cwd || thread.archivedAt !== undefined)
      return yield* notAllowed("Restore a work conversation before moving it.");
    const previousCwd = thread.cwd;
    const lead = (yield* store.listAgents(threadId).pipe(Effect.mapError(unavailable))).find(
      (agent) => agent.parentId === undefined && agent.role === LEAD_ROLE,
    );
    if (!lead) return yield* notFound("This conversation has no lead.");
    const planned = yield* worktrees
      .plan(thread.worktree?.project ?? thread.cwd, thread.title, choice)
      .pipe(Effect.mapError(refusedWorktree));
    yield* worktrees.checkOut(planned.worktree).pipe(Effect.mapError(refusedWorktree));
    return yield* inThread(
      threadId,
      false,
      planned.cwd,
    )(
      Effect.gen(function* () {
        if (working(threadId) || waitsOnUser(threadId) || (yield* threadInfo(threadId)).cwd !== thread.cwd)
          return yield* notAllowed(
            "The conversation changed while its destination was prepared. Retry the move when it is idle.",
          );
        yield* stopThreadAgents(threadId);
        const updated = yield* updateThread(threadId, { cwd: planned.cwd, worktree: planned.worktree });
        yield* store
          .updateAgent(lead.id, { providerSessionId: null, updatedAt: yield* now })
          .pipe(Effect.mapError(unavailable));
        yield* emitStored(lead, {
          _tag: "WorkspaceMoved",
          from: { provider: lead.provider, model: lead.model },
          provider: lead.provider,
          model: lead.model,
          previousCwd,
          cwd: planned.cwd,
        });
        threadDirectories.set(threadId, planned.cwd);
        threadWorktrees.set(threadId, planned.worktree);
        const { rt, undelivered, notices } = yield* resumeLead(lead.id);
        // A new worktree starts empty of what setup installs; an existing checkout has its own.
        const setup =
          choice.path === undefined
            ? setupNote(Option.getOrUndefined(yield* setUp(threadId, planned.worktree, planned.cwd)))
            : "";
        const moved: InputItem = {
          _tag: "SystemNotice",
          text:
            `The thread now works in \`${planned.cwd}\`, on branch \`${planned.worktree.branch}\`.` +
            (options.carryOn === true ? " Carry on with your task there. " : " ") +
            setup +
            portsNote(yield* scripts.ports(threadId)),
        };
        if (options.carryOn === true) {
          rt.userWaiting = undelivered.length > 0;
          yield* Queue.offerAll(rt.inbox, [...undelivered, ...notices, moved]);
        } else {
          held.set(lead.id, { undelivered, notices });
          holdNotice(lead.id, moved);
        }
        return updated;
      }),
    );
  });

  const moveChatToWork = Effect.fn("Orchestrator.moveChatToWork")(function* (input: MoveChatToWorkInput) {
    const { threadId } = input;
    if (working(threadId) || waitsOnUser(threadId)) {
      return yield* notAllowed("Finish the current turn before moving this chat to work.");
    }
    const thread = yield* threadInfo(threadId);
    if (thread.mode !== "chat" || thread.archivedAt !== undefined) {
      return yield* notAllowed("Only an active chat can be moved to work.");
    }
    if (!adapters.has(input.lead.provider)) {
      return yield* noAdapter(input.lead.provider);
    }
    const lead = (yield* store.listAgents(threadId).pipe(Effect.mapError(unavailable))).find(
      (agent) => agent.parentId === undefined && agent.role === LEAD_ROLE,
    );
    if (!lead) return yield* notFound("This chat has no lead.");

    const previousCwd = threadDirectory(thread);
    const wantsWorktree = input.worktree === true || input.workspace !== undefined;
    const planned = wantsWorktree
      ? yield* worktrees.plan(input.cwd, thread.title, input.workspace).pipe(Effect.mapError(refusedWorktree))
      : undefined;
    if (planned !== undefined) {
      yield* worktrees.checkOut(planned.worktree).pipe(Effect.mapError(refusedWorktree));
    }
    const directory = planned?.cwd ?? input.cwd;

    const moved = yield* inThread(
      threadId,
      false,
      directory,
    )(
      Effect.gen(function* () {
        if (working(threadId) || waitsOnUser(threadId) || (yield* threadInfo(threadId)).mode !== "chat") {
          return yield* notAllowed(
            "This chat changed while preparing the project. Try again when it is idle.",
          );
        }
        yield* stopThreadAgents(threadId);
        const updatedAt = yield* now;
        const updated: ThreadInfo = yield* updateThread(threadId, {
          mode: "work",
          cwd: directory,
          ...(planned === undefined ? {} : { worktree: planned.worktree }),
        });
        const autoEffort = input.lead.autoEffort === true;
        yield* store
          .updateAgent(lead.id, {
            provider: input.lead.provider,
            model: input.lead.model,
            effort: input.lead.effort ?? null,
            autoEffort,
            speed: input.lead.speed ?? null,
            access: input.lead.access,
            providerSessionId: null,
            updatedAt,
          })
          .pipe(Effect.mapError(unavailable));
        const {
          effort: _effort,
          autoEffort: _auto,
          speed: _speed,
          providerSessionId: _session,
          ...restLead
        } = lead;
        const nextLead: AgentInfo = {
          ...restLead,
          provider: input.lead.provider,
          model: input.lead.model,
          ...(input.lead.effort ? { effort: input.lead.effort } : {}),
          ...(autoEffort ? { autoEffort } : {}),
          ...(input.lead.speed ? { speed: input.lead.speed } : {}),
          access: input.lead.access,
          updatedAt,
        };
        yield* emitStored(nextLead, {
          _tag: "WorkspaceMoved",
          from: { provider: lead.provider, model: lead.model },
          provider: nextLead.provider,
          model: nextLead.model,
          previousCwd,
          cwd: directory,
        });
        threadModes.set(threadId, "work");
        threadDirectories.set(threadId, directory);
        if (planned !== undefined) threadWorktrees.set(threadId, planned.worktree);

        const { rt, undelivered, notices } = yield* resumeLead(lead.id);
        const setup =
          planned !== undefined && input.workspace?.path === undefined
            ? setupNote(Option.getOrUndefined(yield* setUp(threadId, planned.worktree, directory)))
            : "";
        const branchNote = planned ? `, on branch \`${planned.worktree.branch}\`` : "";
        const movedNotice: InputItem = {
          _tag: "SystemNotice",
          text:
            `This chat was moved to Work in \`${directory}\`${branchNote} (access: ${input.lead.access}). ` +
            "You now have full Work workspace tools and folder access. " +
            setup +
            portsNote(yield* scripts.ports(threadId)),
        };

        held.set(lead.id, { undelivered, notices });
        holdNotice(lead.id, movedNotice);

        return { thread: updated, lead: rt.info };
      }),
    );

    if (input.implement !== undefined) {
      const note = input.implement.note?.trim();
      const excerpt = input.implement.message?.trim();
      const quoted = excerpt
        ? excerpt
            .slice(0, 2_000)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : undefined;
      const prompt = [
        note && note !== "" ? note : "Implement this in the project now based on our conversation.",
        ...(quoted ? [`Target message:\n${quoted}`] : []),
      ].join("\n\n");
      yield* acceptUserMessage(lead.id, prompt);
    }

    return moved;
  });

  const renameThread = (threadId: ThreadId, title: string) => {
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
  };

  const setThreadArchived = Effect.fn("Orchestrator.setThreadArchived")(function* (
    threadId: ThreadId,
    archived: boolean,
    options: PutAwayOptions = {},
  ) {
    if (archived && (working(threadId) || waitsOnUser(threadId))) {
      return yield* notAllowed("A thread can't be archived while its agents are working or waiting on you.");
    }
    const thread = yield* threadInfo(threadId);
    if (
      thread.worktree !== undefined &&
      thread.worktree.id === undefined &&
      archived !== (thread.archivedAt !== undefined)
    ) {
      if (archived) {
        yield* removeWorktree(thread.id, thread.worktree, thread.cwd ?? thread.worktree.root, options);
      } else {
        // Setup runs again whether or not the thread's lead is listening; the terminal shows it.
        yield* ensureWorktree(threadId, thread.worktree, thread.cwd ?? thread.worktree.root);
      }
    }
    if (archived && thread.worktree?.id !== undefined) {
      yield* stopThreadAgents(threadId);
    }
    return yield* updateThread(
      threadId,
      archived ? { archivedAt: yield* now, laterUntil: null } : { archivedAt: null },
    );
  });

  const setThreadLater = (threadId: ThreadId, until: number | undefined) =>
    updateThread(threadId, { laterUntil: until ?? null });

  const setThreadOnLimit = (threadId: ThreadId, policy: LimitPolicy | undefined) =>
    updateThread(threadId, { onLimit: policy ?? null });

  const deleteThread = Effect.fn("Orchestrator.deleteThread")(function* (
    threadId: ThreadId,
    options: PutAwayOptions = {},
  ) {
    const thread = yield* threadInfo(threadId);
    if (working(threadId) || waitsOnUser(threadId)) {
      return yield* notAllowed("A thread can't be deleted while its agents are working or waiting on you.");
    }
    // An archived thread's worktree is gone already; its branch keeps any commits.
    if (
      thread.worktree !== undefined &&
      thread.worktree.id === undefined &&
      thread.archivedAt === undefined
    ) {
      yield* removeWorktree(thread.id, thread.worktree, thread.cwd ?? thread.worktree.root, options);
    }
    // Sessions end first, so nothing they record lands after the rows are gone.
    yield* stopThreadAgents(threadId);
    threadDirectories.delete(threadId);
    threadModes.delete(threadId);
    yield* store.deleteThread(threadId).pipe(Effect.mapError(unavailable));
  });

  const worktreeChanges = Effect.fn("Orchestrator.worktreeChanges")(function* (threadId: ThreadId) {
    const { worktree, archivedAt } = yield* threadInfo(threadId);
    if (worktree === undefined || worktree.id !== undefined || archivedAt !== undefined)
      return { uncommitted: 0, unmerged: 0 };
    return yield* worktrees.changes(worktree).pipe(Effect.mapError(refusedWorktree));
  });

  const listAgents = (threadId: ThreadId) => store.listAgents(threadId).pipe(Effect.mapError(unavailable));

  const threadOverviews = Effect.gen(function* () {
    const threads = yield* store.listThreads;
    const byThread = Map.groupBy(yield* store.listAllAgents, (agent) => agent.threadId);
    const waiting = new Set<ThreadId>();
    for (const rt of runtimes.values()) {
      if (
        (pendingPermissions.get(rt.info.id)?.size ?? 0) > 0 ||
        (openQuestions.get(rt.info.id)?.size ?? 0) > 0
      )
        waiting.add(rt.info.threadId);
    }
    for (const { leadId } of pendingSpawns.values()) {
      const rt = runtimes.get(leadId);
      if (rt !== undefined) waiting.add(rt.info.threadId);
    }
    return threads.map((thread): ThreadOverview => ({
      thread,
      agents: byThread.get(thread.id) ?? [],
      awaitingApproval: waiting.has(thread.id),
    }));
  }).pipe(Effect.mapError(unavailable));

  return {
    listThreads,
    moveThread,
    moveChatToWork,
    renameThread,
    setThreadArchived,
    setThreadLater,
    setThreadOnLimit,
    deleteThread,
    worktreeChanges,
    listAgents,
    threadOverviews,
  };
};
