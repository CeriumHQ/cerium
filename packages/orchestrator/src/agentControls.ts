import type { AgentId, ThreadId } from "@cerium/protocol";
import { Effect, Option, Queue } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { notAllowed, notFound, OrchestratorError, unavailable } from "./errors.ts";
import { CONVERSATION_TAGS, liveEvents, startsAnew } from "./rewind.ts";
import { isHelper, sessionOf } from "./runtime.ts";
import type { SideExchange } from "./sideQuestion.ts";
import type { Turns } from "./turns.ts";
import type { UserRequests } from "./userRequests.ts";

/**
 * What the user does to agents at work: interrupting, steering or compacting a turn, stopping a
 * background task, an agent or a whole thread, and asking a lead a side question.
 */
export const makeAgentControls = (ctx: OrchestratorContext, turns: Turns, requests: UserRequests) => {
  const {
    store,
    adapters,
    config,
    sideQuestions,
    runtimes,
    pendingSpawns,
    pendingPermissions,
    leadRequests,
    messageDelivery,
    agentInfo,
    runtime,
    emit,
    deliver,
    expireQuestions,
    childrenOf,
    threadInfo,
    threadDirectory,
    stopRuntime,
  } = ctx;
  const { steer, compactTurn } = turns;
  const { answerRequest, releaseOwnRequests } = requests;

  const interruptAgent = Effect.fn("Orchestrator.interruptAgent")(function* (
    agentId: AgentId,
    options?: { readonly includeChildren?: boolean },
  ) {
    const rt = yield* runtime(agentId);
    // A session still starting has no turn to interrupt.
    yield* (rt.session?.interrupt ?? Effect.void).pipe(Effect.mapError(unavailable));
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
  });

  const steerAgent = Effect.fn("Orchestrator.steerAgent")(function* (agentId: AgentId) {
    yield* steer(yield* runtime(agentId));
  });

  const compactAgent = Effect.fn("Orchestrator.compactAgent")(function* (agentId: AgentId) {
    const rt = yield* runtime(agentId);
    if (rt.ended) return yield* notFound(`Agent ${agentId} is not running.`);
    const working = new OrchestratorError({
      reason: "invalid",
      message: "The agent is working: compact its conversation once its turn ends.",
    });
    // Reserved before waking the host so it can't be retired before the compaction starts.
    if (!(yield* rt.turnPermit.takeIfAvailable(1))) return yield* working;
    yield* Effect.gen(function* () {
      const session = yield* sessionOf(rt);
      const compact = session.compact;
      if (compact === undefined || adapters.get(rt.info.provider)?.manifest.compact !== true) {
        return yield* new OrchestratorError({
          reason: "invalid",
          message: `${rt.info.provider} can't compact a conversation when asked.`,
        });
      }
      if (rt.turn !== undefined || rt.info.state === "running" || rt.info.state === "queued") {
        return yield* working;
      }
      yield* Effect.forkIn(
        compactTurn(rt, compact).pipe(Effect.ensuring(rt.turnPermit.release(1))),
        rt.scope,
      );
    }).pipe(Effect.onError(() => rt.turnPermit.release(1)));
  });

  const stopBackgroundTask = Effect.fn("Orchestrator.stopBackgroundTask")(function* (
    agentId: AgentId,
    taskId: string,
  ) {
    const rt = yield* runtime(agentId);
    // No session, no tasks: they ended with it.
    if (rt.ended || rt.session === undefined || rt.background === 0) return;
    const session = rt.session;
    if (session.stopBackgroundTask === undefined) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `${rt.info.provider} can't stop its background tasks.`,
      });
    }
    yield* session.stopBackgroundTask(taskId).pipe(Effect.mapError(unavailable));
  });

  const askSideQuestion = Effect.fn("Orchestrator.askSideQuestion")(function* (
    agentId: AgentId,
    question: string,
    earlier: ReadonlyArray<SideExchange>,
  ) {
    const info = yield* agentInfo(agentId);
    if (info.parentId !== undefined) {
      return yield* notAllowed("Only a thread's lead can be asked a side question.");
    }
    const thread = Option.getOrUndefined(
      yield* store.getThread(info.threadId).pipe(Effect.mapError(unavailable)),
    );
    if (thread === undefined) return yield* notFound(`Thread ${info.threadId} does not exist.`);
    const live = liveEvents(
      yield* store.listEvents(agentId, { tags: CONVERSATION_TAGS }).pipe(Effect.mapError(unavailable)),
    );
    // A lead whose session started anew holds none of the conversation before it; the text does.
    return yield* sideQuestions.ask({
      agentId,
      provider: info.provider,
      model: info.model,
      cwd: threadDirectory(thread),
      sessionId: startsAnew(live) ? undefined : info.providerSessionId,
      working: info.state === "running" || info.state === "queued",
      live,
      question,
      earlier,
    });
  });

  const stopAgent = Effect.fn("Orchestrator.stopAgent")(function* (agentId: AgentId) {
    const rt = yield* runtime(agentId);
    const assigned = messageDelivery.taskFor(agentId) !== undefined;
    yield* stopRuntime(rt);
    // A lead waiting on this child would otherwise wait for a result that never comes. An
    // advisor's askers hear from `releaseAdvisor` instead, and a reviewer reports to nobody.
    // An assignment's stop is reported by stopRuntime when its group is finished.
    if (!assigned && rt.info.parentId !== undefined && !isHelper(rt.info)) {
      yield* deliver(rt.info.parentId, {
        _tag: "SystemNotice",
        text: `The user stopped agent ${rt.info.id} "${rt.info.role}"; it will not report back. Carry on without it, or spawn a new agent if you still need that work.`,
      });
    }
  });

  const stopThread = Effect.fn("Orchestrator.stopThread")(function* (threadId: ThreadId) {
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
      yield* Effect.forEach(waiting, (requestId) => answerRequest(rt, requestId, deny).pipe(Effect.ignore), {
        discard: true,
        concurrency: "unbounded",
      });
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
  });

  return {
    interruptAgent,
    steerAgent,
    compactAgent,
    stopBackgroundTask,
    askSideQuestion,
    stopAgent,
    stopThread,
  };
};
