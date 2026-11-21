import type { AgentId, AgentInfo, LimitReached, ModelInfo, ProviderId } from "@cerium/protocol";
import { Clock, Deferred, Duration, Effect, Option, Queue } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import { unavailable } from "./errors.ts";
import type { HandoffTarget } from "./inputs.ts";
import type { LeadSwitching } from "./leadSwitching.ts";
import {
  failoverNotice,
  failoverTarget,
  LIMIT_TAGS,
  limitEpisode,
  openPause,
  pauseEnd,
  resumeNotice,
} from "./limits.ts";
import { liveEvents } from "./rewind.ts";
import type { Runtime } from "./runtime.ts";

/** The longest one timer waits for a paused thread's limit to reset, in milliseconds (a timer's own cap is 24 days). */
const MAX_PAUSE_WAIT = 20 * 24 * 60 * 60 * 1000;

/**
 * What a thread does when its lead's harness runs out of its limit: pause until the reset (surviving a
 * restart), or move on to another harness's model.
 */
export const makeLimitPauses = (ctx: OrchestratorContext, sessions: AgentSessions, leads: LeadSwitching) => {
  const {
    store,
    adapters,
    catalog,
    config,
    settings,
    layerScope,
    pauseTimers,
    forAgent,
    emit,
    cancelPauseTimer,
    threadInfo,
  } = ctx;
  const { liveLead } = sessions;
  const { handOff } = leads;

  /**
   * The pause a lead is in, read from its events so it survives a restart: the latest `LimitPaused`
   * that nothing has ended.
   */
  const pauseOf = (agentId: AgentId) =>
    Effect.gen(function* () {
      const paused = yield* store.listEvents(agentId, { tags: ["LimitPaused"] });
      const last = paused.at(-1);
      if (last === undefined) return undefined;
      const since = yield* store.listEvents(agentId, { afterSequence: last.sequence, tags: LIMIT_TAGS });
      return openPause([last, ...since]);
    }).pipe(Effect.mapError(unavailable));

  /** Sends a paused lead on at `resumeAt`, or at once if that has passed. */
  const schedulePause = (agentId: AgentId, resumeAt: number) =>
    Effect.gen(function* () {
      yield* cancelPauseTimer(agentId);
      // Past what a timer can wait, `resumeFromPause` finds it too early and waits again.
      const wait = Math.min(Math.max(0, resumeAt - (yield* Clock.currentTimeMillis)), MAX_PAUSE_WAIT);
      pauseTimers.set(
        agentId,
        yield* Effect.forkIn(
          Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(resumeFromPause(agentId))),
          layerScope,
        ),
      );
    });

  /**
   * Ends a paused lead's pause: its reset time came. Under the same permit as the user's messages
   * and only while the lead's events still show the pause open, so a pause ends once, whichever of
   * the timer, a message or a restart gets here first. The lead goes on in its own session.
   */
  const resumeFromPause = (agentId: AgentId): Effect.Effect<void> =>
    forAgent(agentId)(
      Effect.gen(function* () {
        // Not interrupted by what ends the pause from here on.
        pauseTimers.delete(agentId);
        const paused = yield* pauseOf(agentId);
        if (paused === undefined) return;
        if (paused.resumeAt > (yield* Clock.currentTimeMillis) + 1_000) {
          return yield* schedulePause(agentId, paused.resumeAt);
        }
        const agent = yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable));
        if (Option.isNone(agent)) return;
        // An archived thread stays as it is until the user brings it back.
        if ((yield* threadInfo(agent.value.threadId)).archivedAt !== undefined) return;
        const { rt, undelivered, notices } = yield* liveLead(agentId);
        const gate = rt.pause;
        rt.pause = undefined;
        yield* emit(rt, { _tag: "LimitResumed", by: "reset" });
        rt.userWaiting = undelivered.length > 0;
        yield* Queue.offerAll(rt.inbox, [
          ...undelivered,
          { _tag: "SystemNotice", text: resumeNotice() },
          ...notices,
        ]);
        if (gate !== undefined) yield* Deferred.succeed(gate, undefined);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Couldn't resume ${agentId} after its harness's limit reset`, cause),
      ),
    );

  /** The lead stops here for its harness's limit to reset, then goes on. */
  const pauseLead = (rt: Runtime, hit: LimitReached, pauses: number) =>
    Effect.gen(function* () {
      const { resumeAt, reported } = pauseEnd(hit, yield* Clock.currentTimeMillis, pauses, {
        retry: Duration.toMillis(config.limitPause.retry),
        margin: Duration.toMillis(config.limitPause.margin),
      });
      rt.pause = yield* Deferred.make<void>();
      yield* emit(rt, {
        _tag: "LimitPaused",
        provider: hit.provider,
        ...(hit.window ? { window: hit.window } : {}),
        resumeAt,
        reported,
        attempt: pauses + 1,
      });
      yield* schedulePause(rt.info.id, resumeAt);
    });

  /** The next model on the roster from a harness that hasn't run out, to carry a lead on. */
  const nextHarness = (info: AgentInfo, tried: ReadonlySet<ProviderId>) =>
    Effect.gen(function* () {
      const installed = (provider: ProviderId) => adapters.has(provider);
      const models = yield* (catalog.models ?? Effect.succeed([])).pipe(
        Effect.timeoutOption("3 seconds"),
        Effect.map(Option.getOrElse((): ReadonlyArray<ModelInfo> => [])),
      );
      if (models.length > 0) {
        const { roster } = yield* settings.get;
        return failoverTarget(roster, models, info, tried, installed);
      }
      const entry = (yield* catalog.entries).find(
        (each) => each.provider !== info.provider && !tried.has(each.provider) && installed(each.provider),
      );
      return entry === undefined
        ? undefined
        : ({
            provider: entry.provider,
            model: entry.model,
            ...(entry.effort ? { effort: entry.effort } : {}),
            ...(entry.speed ? { speed: entry.speed } : {}),
          } satisfies HandoffTarget);
    });

  /**
   * What a thread does about its lead's turn ending at its harness's limit, as the thread or the
   * setting chose. A thread that moves on to another harness never goes back to one that ran out
   * since a turn last completed; with none left it waits instead, and after too many pauses in a
   * row it stops and says so.
   */
  const handleLimit = (rt: Runtime, hit: LimitReached): Effect.Effect<void> =>
    Effect.gen(function* () {
      const thread = yield* threadInfo(rt.info.threadId);
      const policy = thread.onLimit ?? (yield* settings.get).limits.onLimit;
      if (policy === "off") return;
      const episode = limitEpisode(
        liveEvents(
          yield* store.listEvents(rt.info.id, { tags: LIMIT_TAGS }).pipe(Effect.mapError(unavailable)),
        ),
      );
      if (policy === "failover") {
        const target = yield* nextHarness(rt.info, episode.providers);
        if (target !== undefined) {
          // Handed off from outside this fiber, which handing off ends.
          yield* Effect.forkIn(
            handOff(rt.info.id, target, {
              cause: "limit",
              notice: failoverNotice(`${rt.info.model} (${rt.info.provider})`),
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`Couldn't move ${rt.info.id} to ${target.provider} at its limit`, cause),
              ),
            ),
            layerScope,
          );
          return;
        }
      }
      if (episode.pauses >= config.limitPause.maxPauses) {
        yield* emit(rt, {
          _tag: "AgentError",
          kind: "rateLimit",
          message: `Still at its limit after ${episode.pauses} pauses; send a message to try again.`,
          retryable: false,
        });
        return;
      }
      yield* pauseLead(rt, hit, episode.pauses);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Couldn't handle ${rt.info.id}'s limit`, cause)));

  /**
   * Leads a previous run left paused wait for their reset again, or go on at once when it came while
   * Cerium was closed.
   */
  const recoverPauses = Effect.gen(function* () {
    const paused = yield* store.listEventsByTag("LimitPaused").pipe(Effect.mapError(unavailable));
    const latest = new Map(paused.map((event) => [event.agentId, event] as const));
    yield* Effect.forEach(
      latest.keys(),
      (agentId) =>
        pauseOf(agentId).pipe(
          Effect.flatMap((open) =>
            open === undefined ? Effect.void : schedulePause(agentId, open.resumeAt),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't recover paused threads", cause)));

  return {
    handleLimit,
    recoverPauses,
  };
};

export type LimitPauses = ReturnType<typeof makeLimitPauses>;
