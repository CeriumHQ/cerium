import {
  ADVISOR_ROLE,
  narrowAccess,
  REVIEWER_ROLE,
  type AccessMode,
  type AdvisorSettings,
  type AgentId,
  type AgentInfo,
  type EventPayload,
  type FromAgent,
  type ProviderId,
  type ReasoningEffort,
  type ThreadId,
} from "@cerium/protocol";
import { Deferred, Effect } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import type { MessageOptions } from "./delivery.ts";
import { noAdapter, notAllowed, notFound, OrchestratorError, unavailable } from "./errors.ts";
import type { SpawnApproval, SpawnOutcome, SpawnRequest } from "./inputs.ts";
import { isAdvisor, isHelper, resolveTarget, type Runtime, type SpawnTarget } from "./runtime.ts";

/**
 * The agents a lead works with and how they talk: the children it spawns (some with the user's
 * approval), the thread's advisor, the reviewers the user starts, and messages between agents.
 */
export const makeAgentTeam = (ctx: OrchestratorContext, sessions: AgentSessions) => {
  const {
    store,
    adapters,
    catalog,
    config,
    settings,
    routerOn,
    runtimes,
    threadDirectories,
    threadModes,
    pendingSpawns,
    messageDelivery,
    advisors,
    advisorQuestions,
    advisorPermit,
    reviews,
    makeId,
    runtime,
    now,
    emit,
    emitTo,
    deliver,
    holdNotice,
    releaseAdvisor,
    releaseReview,
    spend,
    threadInfo,
    threadDirectory,
    stopRuntime,
  } = ctx;
  const { startRuntime } = sessions;

  /** A child never gets more access than its lead, and only reads in a chat. */
  const childAccess = (lead: Runtime, request: SpawnRequest): AccessMode =>
    (threadModes.get(lead.info.threadId) ?? "work") === "chat"
      ? "readOnly"
      : narrowAccess(lead.info.access, request.access ?? lead.info.access);

  const assignmentFor = (lead: Runtime, childId: AgentId, prompt: string) =>
    Effect.gen(function* () {
      const requestId = yield* makeId("task");
      messageDelivery.request({
        id: requestId,
        from: lead.info.id,
        to: childId,
        task: true,
        group: lead.currentTurnId,
      });
      return {
        _tag: "FromAgent",
        agentId: lead.info.id,
        threadId: lead.info.threadId,
        kind: "request",
        requestId,
        text: prompt,
      } satisfies FromAgent;
    });

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
        includeUserMcpServers: request.includeUserMcpServers === true,
        initial: yield* assignmentFor(lead, child.id, request.prompt),
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

  /** Counts one more message from `key`'s sender against the per-pair budget. */
  const spendBudget = (key: string, to: string) =>
    spend(
      key,
      config.messageBudget,
      (recent) =>
        `You have sent ${recent} messages to ${to} recently, the most allowed. Finish your task or wait.`,
    );

  const spawn = Effect.fn("Orchestrator.spawn")(function* (callerId: AgentId, request: SpawnRequest) {
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
      return yield* noAdapter(request.provider);
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
  });

  const resolveSpawnApproval = Effect.fn("Orchestrator.resolveSpawnApproval")(function* (
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
  });

  const continueChild = Effect.fn("Orchestrator.continueChild")(function* (
    callerId: AgentId,
    childId: AgentId,
    prompt: string,
  ) {
    const lead = yield* runtime(callerId);
    if (lead.info.parentId !== undefined) {
      return yield* notAllowed("Only a thread's lead can continue child agents.");
    }
    const child = yield* runtime(childId);
    if (child.ended) return yield* notFound(`Agent ${childId} is not running.`);
    if (child.info.parentId !== callerId) return yield* notAllowed(`Agent ${childId} is not your child.`);
    if (isHelper(child.info)) return yield* notAllowed("Only assigned workers can take follow-up tasks.");
    if (prompt.length > config.maxDeliveredChars) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `The prompt is ${prompt.length} characters; the limit is ${config.maxDeliveredChars}.`,
      });
    }
    const id = yield* makeId("msg");
    yield* deliver(childId, { ...(yield* assignmentFor(lead, childId, prompt)), id });
  });

  const sendMessage = Effect.fn("Orchestrator.sendMessage")(function* (
    callerId: AgentId,
    to: AgentId,
    text: string,
    options: MessageOptions = {},
  ) {
    const from = yield* runtime(callerId);
    if (from.info.parentId !== undefined) {
      return yield* notAllowed(
        "Child agents do not send messages; return your result or blocker at the end of your turn.",
      );
    }
    const stopped = notFound(
      `Agent ${to} isn't running, so it can't take messages: it was stopped, or its thread waits for the user to pick it back up. \`list_threads\` shows which leads are working.`,
    );
    const recipient = yield* runtime(to).pipe(Effect.mapError(() => stopped));
    // An agent whose session ended would drop the message while the sender heard it was delivered.
    if (recipient.ended) return yield* stopped;
    if (recipient.info.parentId === callerId) {
      return yield* notAllowed(
        "Use `continue_agent` to send follow-up instructions to a child agent; `send_message` is for messaging another thread's lead.",
      );
    }
    if (recipient.info.parentId !== undefined) {
      return yield* notAllowed("Across threads only leads can message each other; ask that thread's lead.");
    }
    if (to === callerId) return yield* notAllowed("Use `send_message` to reach another thread's lead.");
    if (text.length > config.maxDeliveredChars) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `The message is ${text.length} characters; the limit is ${config.maxDeliveredChars}. Summarize it.`,
      });
    }
    const legacyAnswer =
      options.kind === undefined && options.reply !== true
        ? messageDelivery.legacyReply(callerId, to)
        : undefined;
    const kind = options.kind ?? (options.reply === true ? "request" : legacyAnswer ? "reply" : "note");
    let requestId = options.requestId ?? legacyAnswer;
    if (kind === "reply") {
      if (requestId === undefined || !messageDelivery.answer(callerId, to, requestId)) {
        return yield* new OrchestratorError({
          reason: "invalid",
          message: "Reply with the requestId of an open request addressed to you.",
        });
      }
    } else {
      yield* spendBudget(`${callerId}->${to}`, to);
      if (kind === "request") {
        requestId = yield* makeId("req");
        messageDelivery.request({
          id: requestId,
          from: callerId,
          to,
          task: false,
          legacy: options.reply === true,
          group: from.currentTurnId,
        });
      }
    }
    const message: FromAgent = {
      _tag: "FromAgent",
      id: yield* makeId("msg"),
      agentId: callerId,
      threadId: from.info.threadId,
      text,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
    };
    const wakes =
      kind === "reply" ||
      (kind === "request" && messageDelivery.takeWake(from.info.threadId, config.automaticWakeLimit));
    if (wakes) {
      yield* deliver(to, message);
      return { held: false, ...(requestId === undefined ? {} : { requestId }) };
    }
    yield* emit(recipient, { _tag: "MessageHeld", message });
    holdNotice(to, message);
    return {
      held: true,
      ...(requestId === undefined ? {} : { requestId }),
      ...(kind === "request"
        ? {
            reason:
              "Automatic turn budget reached. The request is saved for the recipient's next user-initiated turn; do independent work or report that it is waiting.",
          }
        : {}),
    };
  });

  const askAdvisor = Effect.fn("Orchestrator.askAdvisor")(function* (callerId: AgentId, question: string) {
    const asker = yield* runtime(callerId);
    if (isAdvisor(asker.info)) {
      return yield* notAllowed("You are the advisor: answer the question you were asked.");
    }
    const { advisor: chosen, disabledProviders } = yield* settings.get;
    if (!chosen.enabled || chosen.model === undefined) {
      return yield* new OrchestratorError({
        reason: "unavailable",
        message:
          "The user hasn't turned on an advisor (Settings → Tools). Carry on, or ask the user instead.",
      });
    }
    if (disabledProviders.includes(chosen.model.provider)) {
      return yield* new OrchestratorError({
        reason: "unavailable",
        message: `The advisor runs on ${chosen.model.provider}, which is turned off in Settings → Harnesses.`,
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
    if (!messageDelivery.takeWake(asker.info.threadId, config.automaticWakeLimit)) {
      return yield* new OrchestratorError({
        reason: "budgetExceeded",
        message:
          "Automatic turn budget reached. Do independent work or report that advice is waiting for the user's next turn; do not retry now.",
      });
    }
    yield* spendBudget(`${callerId}->${ADVISOR_ROLE}`, "the advisor");
    const model = chosen.model;
    return yield* advisorPermit.withPermits(1)(
      Effect.gen(function* () {
        const advisor = yield* advisorFor(asker, model);
        advisorQuestions.set(advisor.info.id, [...(advisorQuestions.get(advisor.info.id) ?? []), callerId]);
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
  });

  const startReview = Effect.fn("Orchestrator.startReview")(function* (
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
      return yield* notAllowed("This thread's worktree was removed when it was archived; restore it first.");
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
    yield* emitTo(lead, live, spawned);
    const reply = yield* Deferred.make<string, OrchestratorError>();
    reviews.set(info.id, reply);
    const rt = yield* startRuntime(info, threadDirectories.get(threadId) ?? threadDirectory(thread), {
      initial: { _tag: "SystemNotice", text: prompt },
    });
    // One that ended as it started would leave the review waiting.
    if (rt.ended) yield* releaseReview(rt);
    return { agentId: info.id, reply: Deferred.await(reply) };
  });

  const killChild = Effect.fn("Orchestrator.killChild")(function* (callerId: AgentId, childId: AgentId) {
    const child = yield* runtime(childId);
    if (child.info.parentId !== callerId) {
      return yield* notAllowed(`Agent ${childId} is not your child.`);
    }
    yield* stopRuntime(child);
  });

  const agent = (agentId: AgentId) => runtime(agentId).pipe(Effect.map((rt) => rt.info));

  return {
    childAccess,
    spawn,
    resolveSpawnApproval,
    continueChild,
    sendMessage,
    askAdvisor,
    startReview,
    killChild,
    agent,
  };
};

export type AgentTeam = ReturnType<typeof makeAgentTeam>;
