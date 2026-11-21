import type { AgentId, AgentInfo, InputItem } from "@cerium/protocol";
import { Deferred, Effect, Queue } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import { noAdapter, notAllowed, OrchestratorError, unavailable } from "./errors.ts";
import type { HandoffTarget, ModelChoice } from "./inputs.ts";
import { choiceOf } from "./runtime.ts";

/** What a thread's lead runs on: another model, effort or speed of its harness, or another harness. */
export const makeLeadSwitching = (ctx: OrchestratorContext, sessions: AgentSessions) => {
  const {
    store,
    adapters,
    runtimes,
    held,
    forAgent,
    agentInfo,
    now,
    emitStored,
    recordModel,
    expireQuestions,
    threadInfo,
    stopRuntime,
  } = ctx;
  const { resumeLead } = sessions;

  /** How long a handoff waits for the turn it stopped to end before it ends the session anyway. */
  const HANDOFF_STOP_TIMEOUT = "15 seconds";

  /**
   * Hands a lead to another harness (see `handOffLead`). A running turn is stopped and given time
   * to end, so the transcript records how it ended; what waited in its inbox stays: the user's
   * messages come back from the history, and the rest goes to the new session.
   */
  const handOff = Effect.fn("Orchestrator.handOff")(function* (
    agentId: AgentId,
    target: HandoffTarget,
    options: { readonly cause?: "limit"; readonly notice?: string } = {},
  ) {
    const live = runtimes.get(agentId);
    const info = yield* agentInfo(agentId);
    if (info.parentId !== undefined) {
      return yield* notAllowed("Only a thread's lead can be handed to another harness.");
    }
    if (target.provider === info.provider) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `The lead already runs on ${info.provider}: switch its model instead.`,
      });
    }
    if (!adapters.has(target.provider)) {
      return yield* noAdapter(target.provider);
    }
    const thread = yield* threadInfo(info.threadId);
    if (thread.worktree !== undefined && thread.archivedAt !== undefined) {
      return yield* notAllowed("This thread's worktree was removed when it was archived; restore it first.");
    }

    const carried: Array<InputItem> = [];
    if (live !== undefined && !live.ended) {
      // Taken out first, so the stopped turn's end doesn't start another on the old harness.
      carried.push(...(yield* Queue.clear(live.inbox)).filter((item) => item._tag !== "FromUser"));
      live.userWaiting = false;
      const turn = live.turn;
      if (turn !== undefined) {
        yield* (live.session?.interrupt ?? Effect.void).pipe(Effect.ignore);
        yield* expireQuestions(live).pipe(Effect.ignore);
        yield* Deferred.await(turn).pipe(Effect.timeoutOption(HANDOFF_STOP_TIMEOUT));
      }
      yield* stopRuntime(live);
    }
    held.delete(agentId);
    // What the new session is to do first, after the brief: told in the notice that follows it.
    if (options.notice !== undefined) carried.push({ _tag: "SystemNotice", text: options.notice });

    const updatedAt = yield* now;
    const autoEffort = target.autoEffort === true;
    yield* store
      .updateAgent(agentId, {
        provider: target.provider,
        model: target.model,
        effort: target.effort ?? null,
        autoEffort,
        speed: target.speed ?? null,
        providerSessionId: null,
        updatedAt,
      })
      .pipe(Effect.mapError(unavailable));
    const { effort: _effort, autoEffort: _auto, speed: _speed, providerSessionId: _session, ...rest } = info;
    const next: AgentInfo = {
      ...rest,
      provider: target.provider,
      model: target.model,
      ...(target.effort ? { effort: target.effort } : {}),
      ...(autoEffort ? { autoEffort } : {}),
      ...(target.speed ? { speed: target.speed } : {}),
      updatedAt,
    };
    yield* emitStored(next, {
      _tag: "LeadHandedOff",
      ...(options.cause ? { cause: options.cause } : {}),
      from: { provider: info.provider, model: info.model },
      provider: target.provider,
      model: target.model,
      ...(target.effort ? { effort: target.effort } : {}),
      ...(autoEffort ? { autoEffort } : {}),
      ...(target.speed ? { speed: target.speed } : {}),
    });
    // Started at once, so the new harness's session is ready by the user's next message. What the
    // old session had still to take goes on now, with the brief; otherwise it waits for the user.
    const { rt, undelivered, notices } = yield* resumeLead(agentId);
    if (undelivered.length === 0 && carried.length === 0) held.set(agentId, { undelivered, notices });
    else {
      rt.userWaiting = undelivered.length > 0;
      yield* Queue.offerAll(rt.inbox, [...undelivered, ...notices, ...carried]);
    }
    return rt.info;
  });

  // Ordered with the user's messages, like a switch within the harness.
  const handOffLead = (agentId: AgentId, target: HandoffTarget) =>
    forAgent(agentId)(handOff(agentId, target));

  // Ordered with the user's messages: one sent before the switch may still run on it, and a
  // lead being picked back up has its runtime before the switch is recorded.
  const switchModel = (agentId: AgentId, picked: ModelChoice) =>
    forAgent(agentId)(
      Effect.gen(function* () {
        const rt = runtimes.get(agentId);
        const info = yield* agentInfo(agentId);
        if (info.parentId !== undefined) {
          return yield* notAllowed("Only a thread's lead can be switched to another model.");
        }
        const current = choiceOf(info);
        // No effort for the same model keeps the one it has, which its session also keeps.
        const { effort, model } =
          picked.effort === undefined && picked.model === current.model ? current : picked;
        // Auto stays as it is unless named: on it, a picked effort is the one it falls back to.
        const autoEffort = picked.autoEffort ?? current.autoEffort === true;
        // Likewise no speed for the same model keeps its speed, as a client before speeds asks.
        const speed =
          picked.speed === undefined && picked.model === current.model ? current.speed : picked.speed;
        const choice: ModelChoice = {
          model,
          ...(effort ? { effort } : {}),
          ...(autoEffort ? { autoEffort } : {}),
          ...(speed ? { speed } : {}),
        };
        if (
          choice.model === current.model &&
          choice.effort === current.effort &&
          choice.autoEffort === current.autoEffort &&
          choice.speed === current.speed
        ) {
          return info;
        }
        const switching = adapters.get(info.provider)?.manifest.switching;
        if (choice.model !== current.model && switching?.model !== true) {
          return yield* notAllowed(`${info.provider} can't switch a session to another model.`);
        }
        if (choice.effort !== undefined && choice.effort !== current.effort && switching?.effort !== true) {
          return yield* notAllowed(`${info.provider} can't change a session's effort.`);
        }
        if (choice.speed !== undefined && choice.speed !== current.speed && switching?.speed !== true) {
          return yield* notAllowed(`${info.provider} can't change a session's speed.`);
        }
        return yield* recordModel(info, rt, choice);
      }),
    );

  return {
    handOff,
    handOffLead,
    switchModel,
  };
};

export type LeadSwitching = ReturnType<typeof makeLeadSwitching>;
