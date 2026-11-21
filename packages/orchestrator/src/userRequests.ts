import type { AgentSession, PermissionDecision } from "@cerium/harness";
import type {
  AccessMode,
  AgentId,
  EventPayload,
  InputItem,
  Question,
  QuestionResponse,
} from "@cerium/protocol";
import { Deferred, Effect, Option } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { notAllowed, notFound, OrchestratorError } from "./errors.ts";
import { permissionNotice } from "./prompts.ts";
import { answerNotice, answerProblem, questionProblem, tidyResponse } from "./questions.ts";
import { isAdvisor, sessionOf, type OpenQuestion, type Runtime } from "./runtime.ts";

/** How many `ask_user` calls an agent may have waiting at once. */
const MAX_OPEN_QUESTIONS = 4;

/**
 * Read-only agents never wait on the user: each harness already keeps them from
 * writing, so Cerium approves what they ask itself. Tools of the user's own MCP servers still ask (the
 * user, or a child's lead), since those can change things outside Cerium; every adapter names them
 * `mcp__<server>…`.
 */
export const approvesItself = (access: AccessMode, toolName: string) =>
  access === "readOnly" && !toolName.startsWith("mcp__");

export type PermissionRequest = Extract<EventPayload, { readonly _tag: "PermissionRequested" }>;

/**
 * What agents wait on the user for, or a child on its lead: permission requests (a harness's, or one
 * Cerium raises for its own tools with `requestApproval`) and the questions of `ask_user`.
 */
export const makeUserRequests = (ctx: OrchestratorContext) => {
  const {
    store,
    runtimes,
    pendingPermissions,
    leadRequests,
    openQuestions,
    ownRequests,
    allowedTools,
    messageDelivery,
    makeId,
    runtime,
    emit,
    emitStored,
    deliver,
    holdNotice,
    closeQuestion,
    childrenOf,
  } = ctx;

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

  const respondToPermission = (agentId: AgentId, requestId: string, decision: PermissionDecision) =>
    runtime(agentId).pipe(Effect.flatMap((rt) => answerRequest(rt, requestId, decision)));

  const answerQuestion = Effect.fn("Orchestrator.answerQuestion")(function* (
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
    // A user decision unblocks a pending child assignment; other dismissals wait.
    messageDelivery.userTurn(rt.info.threadId);
    if (given.outcome === "dismissed" && messageDelivery.taskFor(agentId) === undefined) {
      holdNotice(agentId, notice);
    } else yield* deliver(agentId, notice);
  });

  const askUser = Effect.fn("Orchestrator.askUser")(function* (
    callerId: AgentId,
    questions: readonly [Question, ...Array<Question>],
  ) {
    const asker = yield* runtime(callerId);
    if (isAdvisor(asker.info)) {
      return yield* notAllowed("You are the advisor: answer the question you were asked.");
    }
    const problem = questionProblem(questions);
    if (problem !== undefined) return yield* new OrchestratorError({ reason: "invalid", message: problem });
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
  });

  const answerChildPermission = Effect.fn("Orchestrator.answerChildPermission")(function* (
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
  });

  /** Asks before one of Cerium's own tools acts; see the service's `requestApproval`. */
  const requestApproval = Effect.fn("Orchestrator.requestApproval")(function* (
    callerId: AgentId,
    request: { readonly toolName: string; readonly summary: string; readonly input: unknown },
  ) {
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
  });

  // No session survived the last exit, so no question asked before it can be answered. They are closed
  // in the threads now, not left for a device that reads the thread later to show as open.
  const expireLeftoverQuestions = Effect.gen(function* () {
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
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't close the questions left open", cause)));

  return {
    askLead,
    closeLeadRequest,
    answerRequest,
    releaseOwnRequests,
    releaseLeadRequests,
    respondToPermission,
    answerQuestion,
    askUser,
    answerChildPermission,
    requestApproval,
    expireLeftoverQuestions,
  };
};
export type UserRequests = ReturnType<typeof makeUserRequests>;
