import type { EffortRouted, InputItem, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { Clock, Effect, Option, Result } from "effect";

import type { OrchestratorContext } from "./context.ts";
import {
  POLICY_VERSION,
  clipContext,
  selectEffort,
  supportedLevel,
  validProbabilities,
  DECISION_TIMEOUT,
  effortState,
  likeliest,
  RECENT_EXCHANGES,
  type Exchange,
} from "./effort.ts";
import { renderTurn } from "./prompts.ts";
import type { Runtime } from "./runtime.ts";

/** The effort router: on an agent set to Auto, it picks the effort of each turn about to start. */
export const makeEffortRouting = (ctx: OrchestratorContext) => {
  const { store, catalog, decider, routerOn } = ctx;

  /** The agent's last exchanges, read from its stored events the first time the router needs them. */
  const recentOf = (rt: Runtime) =>
    Effect.gen(function* () {
      if (rt.recent !== undefined) return rt.recent;
      const events = yield* store
        .listEvents(rt.info.id, {
          tags: ["TurnInput", "MessageCompleted", "TurnCompleted", "ConversationRewound"],
        })
        .pipe(Effect.orElseSucceed(() => []));
      const recent: Array<Exchange> = [];
      let sent: string | undefined;
      let replied = "";
      for (const { payload } of events) {
        if (payload._tag === "TurnInput") {
          sent = renderTurn(payload.items);
          replied = "";
        } else if (payload._tag === "MessageCompleted") {
          replied = payload.text;
        } else if (payload._tag === "TurnCompleted" && sent !== undefined) {
          recent.push({ sent, replied });
          sent = undefined;
        } else if (payload._tag === "ConversationRewound") {
          recent.length = 0;
        }
      }
      rt.recent = recent.slice(-RECENT_EXCHANGES);
      return rt.recent;
    });

  /**
   * On an agent set to Auto, the effort router picks the effort of the turn about to start, and
   * the thread records what it decided. A model that starts its prompt cache over when effort
   * changes is routed only on a new session's first turn. The level picked for the agent is the
   * one it falls back to where the decision model can't decide; the router's levels hold for its
   * session only. Whatever else goes wrong, the turn runs at the picked level and goes ahead.
   */
  const routeEffort = (rt: Runtime, items: readonly [InputItem, ...Array<InputItem>]) =>
    Effect.gen(function* () {
      rt.effortDecision = undefined;
      rt.routedEffort = undefined;
      if (rt.info.autoEffort !== true || !(yield* routerOn)) return;
      const models = yield* (catalog.models ?? Effect.succeed([])).pipe(
        Effect.timeoutOption("3 seconds"),
        Effect.map(Option.getOrElse((): ReadonlyArray<ModelInfo> => [])),
      );
      const model = models.find((each) => each.provider === rt.info.provider && each.id === rt.info.model);
      const [lowest, ...higher] = model?.efforts ?? [];
      // Nothing to pick between.
      if (model === undefined || lowest === undefined || higher.length === 0) return;
      const levels = [lowest, ...higher] as const;
      // The level its session runs at: the last turn's.
      const current = rt.applied.effort ?? rt.info.effort ?? model.defaultEffort;
      // Where the router can't decide, the turn runs at the level picked for the agent, as near as
      // the model has.
      const fallback = supportedLevel(levels, rt.info.effort ?? model.defaultEffort ?? "high");
      /** The turn runs at `effort`, for this turn only; the picked level stays as it is. */
      const runAt = (effort: ReasoningEffort, decision: Omit<EffortRouted, "_tag" | "effort">) =>
        Effect.sync(() => {
          rt.routedEffort = effort;
          rt.effortDecision = { _tag: "EffortRouted", effort, ...decision };
        });
      const fallBack = (kept: "timeout" | "failed", extra: Partial<EffortRouted>) =>
        runAt(fallback, { kept, baselineEffort: fallback, ...extra });
      if (model.cacheSafeEffort !== true && !rt.fresh) {
        if (current !== undefined && levels.includes(current)) rt.routedEffort = current;
        rt.effortDecision = {
          _tag: "EffortRouted",
          ...(current ? { effort: current } : {}),
          kept: "cache",
        };
        return;
      }

      const history = yield* store.listEvents(rt.info.id, {
        tags: ["TurnInput", "TodosUpdated", "ConversationRewound"],
      });
      let task = "";
      let latestRequest = "";
      let pending: string[] = [];
      for (const { payload } of history) {
        if (payload._tag === "ConversationRewound") {
          task = "";
          latestRequest = "";
          pending = [];
        }
        if (payload._tag === "TurnInput")
          for (const item of payload.items) {
            if (item._tag === "FromUser") {
              if (!task) task = item.text;
              if (item.text.length >= 80) latestRequest = item.text;
            }
          }
        if (payload._tag === "TodosUpdated")
          pending = payload.items
            .filter((item) => item.status === "pending" || item.status === "inProgress")
            .slice(0, 12)
            .map((item) => clipContext(item.text, 200));
      }
      if (rt.lastTurn === undefined) {
        const lastInput = history.findLast((event) => event.payload._tag === "TurnInput");
        if (lastInput) {
          const facts = yield* store.listEvents(rt.info.id, {
            afterSequence: lastInput.sequence,
            tags: ["ToolCallStarted", "ToolCallCompleted", "FileChanged", "AgentError", "TurnCompleted"],
          });
          rt.lastTurn = {
            toolCalls: facts.filter((event) => event.payload._tag === "ToolCallStarted").length,
            toolErrors: facts.filter(
              (event) => event.payload._tag === "ToolCallCompleted" && event.payload.isError,
            ).length,
            seconds: Math.max(0, Math.round(((facts.at(-1)?.at ?? lastInput.at) - lastInput.at) / 1000)),
            filesChanged: new Set(
              facts.flatMap((event) => (event.payload._tag === "FileChanged" ? [event.payload.path] : [])),
            ).size,
            failed: facts.some(
              (event) =>
                event.payload._tag === "AgentError" ||
                (event.payload._tag === "TurnCompleted" && event.payload.stopReason === "error"),
            ),
            stopReason:
              facts
                .flatMap((event) =>
                  event.payload._tag === "TurnCompleted" ? [event.payload.stopReason] : [],
                )
                .at(-1) ?? "interrupted",
          };
        }
      }
      const state = {
        // The first request anchors approvals; pending items carry the current scope.
        ...effortState(
          {
            from: items.some((item) => item._tag === "FromUser") ? "user" : "agent",
            text: renderTurn(items),
          },
          yield* recentOf(rt),
          rt.lastTurn,
        ),
        task: clipContext(task === latestRequest ? task : `${task}\n${latestRequest}`, 2000),
        pending,
        model: { provider: rt.info.provider, id: rt.info.model },
      };
      const question = { levels, state };
      const startedAt = yield* Clock.currentTimeMillis;
      const asked = yield* decider
        .decide(question)
        .pipe(Effect.timeoutOption(DECISION_TIMEOUT), Effect.result);
      const ms = (yield* Clock.currentTimeMillis) - startedAt;
      if (Result.isFailure(asked)) return yield* fallBack("failed", { ms, detail: asked.failure.message });
      if (Option.isNone(asked.success)) return yield* fallBack("timeout", { ms });
      const answer = asked.success.value;
      const cost = answer.costUsd === undefined ? {} : { costUsd: answer.costUsd };
      const top = likeliest(levels, answer.probabilities);
      if (top === undefined || !validProbabilities(answer.probabilities, levels.length))
        return yield* fallBack("failed", {
          ms,
          ...cost,
          detail: "The answer contained invalid probabilities.",
        });
      const selected = selectEffort(question, answer, current, fallback);
      yield* runAt(selected.effort, {
        policyVersion: POLICY_VERSION,
        ...(selected.kept === undefined ? {} : { kept: selected.kept }),
        proposedEffort: top,
        baselineEffort: fallback,
        question,
        levels: [...levels],
        probabilities: [...answer.probabilities],
        ...(current ? { beforeEffort: current } : {}),
        ...(answer.decisionModel ? { decisionModel: answer.decisionModel } : {}),
        ...(answer.taskType ? { taskType: answer.taskType } : {}),
        ...(answer.contextSufficient === undefined ? {} : { contextSufficient: answer.contextSufficient }),
        ms,
        confidence: Math.min(1, Math.max(0, answer.confidence)),
        ...cost,
      });
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Couldn't route ${rt.info.id}'s effort`, cause)));

  return {
    routeEffort,
  };
};
