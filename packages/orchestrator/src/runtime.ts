import type { AgentSession } from "@cerium/harness";
import {
  ADVISOR_ROLE,
  REVIEWER_ROLE,
  type AgentInfo,
  type EffortRouted,
  type InputItem,
  type LimitReached,
  type ModelSpeed,
  type ProviderId,
  type Question,
  type ReasoningEffort,
} from "@cerium/protocol";
import { Clock, Deferred, Effect, Queue, Scope, Semaphore } from "effect";

import type { Exchange, TurnFacts } from "./effort.ts";
import { notFound, type OrchestratorError } from "./errors.ts";
import type { ModelChoice, SpawnRequest } from "./inputs.ts";
import type { CatalogEntry } from "./services.ts";

// A live agent as the orchestrator holds it, and what is read off one: its role, the model it runs
// and its harness session.

export interface SpawnTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** The roster's speed for it; absent, the harness's own default. */
  readonly speed?: ModelSpeed;
}

/**
 * Questions an agent put to the user with `ask_user`, which returned at once: they wait for the
 * answers, which reach the agent as a notice whenever they come.

/**
 * Questions an agent put to the user with `ask_user`, which returned at once: they wait for the
 * answers, which reach the agent as a notice whenever they come.
 */
export type OpenQuestion = readonly [Question, ...Array<Question>];

/** A live agent: the inbox Cerium delivers turns from, and its harness session once that has started. */
export interface Runtime {
  info: AgentInfo;
  /** Undefined while the harness session starts; messages wait in the inbox meanwhile. */
  session: AgentSession | undefined;
  /** Settles once the session has started, or failed to. */
  started: Deferred.Deferred<AgentSession, OrchestratorError>;
  sessionScope: Scope.Closeable | undefined;
  readonly sessionPermit: Semaphore.Semaphore;
  sleeping: boolean;
  touchedAt: number;
  /** Set once per host start, independent of later use. */
  sessionExpiresAt: number | undefined;
  wakeSession: Effect.Effect<void>;
  readonly inbox: Queue.Queue<InputItem>;
  /** The turn loop took input from the inbox and is still gathering its batch. */
  preparingTurn: boolean;
  readonly scope: Scope.Closeable;
  sequence: number;
  /** Completed when the current turn's `TurnCompleted` arrives (or the session ends). */
  turn: Deferred.Deferred<void> | undefined;
  /** Held for each turn, so a compaction the user asked for never runs beside one. */
  readonly turnPermit: Semaphore.Semaphore;
  /** The last completed message of the current turn, delivered to the lead when a child finishes. */
  lastMessage: string | undefined;
  ended: boolean;
  /** The user stopped the turn in progress with "stop everything": its end wakes nobody. */
  halted: boolean;
  /** The user's messages wait in the inbox for the agent's next turn. */
  userWaiting: boolean;
  /** The tool calls of the turn in progress that haven't finished. */
  readonly openCalls: Set<string>;
  /** How many background tasks the session runs, which keep it from being retired while idle. */
  background: number;
  /** Cerium interrupted the turn in progress to hand the agent the user's waiting messages. */
  steering: boolean;
  /**
   * The model, effort and speed its harness session runs with; its next turn brings them in line with
   * `info`.
   */
  applied: ModelChoice;
  /** Its session is new and has run no turn: the one turn the router may route on any model. */
  fresh: boolean;
  /** The exchanges before its next turn, for the effort router; read from the store when first needed. */
  recent: Array<Exchange> | undefined;
  /** How its last turn went, for the effort router. */
  lastTurn: TurnFacts | undefined;
  /** The tool calls, failure and changed files of the turn in progress. */
  turnToolCalls: number;
  turnFailed: boolean;
  turnToolErrors: number;
  turnStopReason: string | undefined;
  effortDecision: EffortRouted | undefined;
  /**
   * On Auto, the level the effort router runs its turns at, in place of the level picked for it
   * (`info.effort`), which stays the one it falls back to.
   */
  routedEffort: ReasoningEffort | undefined;
  readonly turnFiles: Set<string>;
  /** The limit the turn in progress ran into, the first it reported. */
  limit: LimitReached | undefined;
  /**
   * Set while the lead is paused at its harness's limit: the turn loop takes nothing from the inbox
   * until it is lifted, when the reset time comes or the user sends a message.
   */
  pause: Deferred.Deferred<void> | undefined;
  /**
   * The provider's message last stored with one of its events. A message makes several events (an
   * edit of many files, a reply with tool calls), and each kept the whole of it again.
   */
  storedRaw: unknown;
  instructions: string | undefined;
  currentTurnId: string | undefined;
  currentRequestId: string | undefined;
  readonly activeAssignments: Set<string>;
  turnCause: "user" | "agentRequest" | "agentReply" | "childResult" | "notice" | "compact";
}

/** The model, effort and speed an agent's record says it runs with. */
export const choiceOf = (info: AgentInfo): ModelChoice => ({
  model: info.model,
  ...(info.effort ? { effort: info.effort } : {}),
  ...(info.autoEffort ? { autoEffort: true } : {}),
  ...(info.speed ? { speed: info.speed } : {}),
});

/** A thread's advisor: the read-only child Cerium starts for `ask_advisor`. */
export const isAdvisor = (info: AgentInfo) => info.parentId !== undefined && info.role === ADVISOR_ROLE;

/** A cross-harness reviewer: the read-only child Cerium starts for `startReview`. */
export const isReviewer = (info: AgentInfo) => info.parentId !== undefined && info.role === REVIEWER_ROLE;

/** A child Cerium starts itself, whose answers go elsewhere than its lead: the advisor or a reviewer. */
export const isHelper = (info: AgentInfo) => isAdvisor(info) || isReviewer(info);

/** A new runtime for `info`, live in `scope`, whose next event is `sequence`; its session isn't started. */
export const makeRuntime = (
  info: AgentInfo,
  options: { readonly scope: Scope.Closeable; readonly sequence: number; readonly fresh: boolean },
) =>
  Effect.gen(function* () {
    const rt: Runtime = {
      info,
      session: undefined,
      started: yield* Deferred.make<AgentSession, OrchestratorError>(),
      sessionScope: undefined,
      sessionPermit: yield* Semaphore.make(1),
      sleeping: false,
      touchedAt: yield* Clock.currentTimeMillis,
      sessionExpiresAt: undefined,
      wakeSession: Effect.void,
      inbox: yield* Queue.unbounded<InputItem>(),
      preparingTurn: false,
      scope: options.scope,
      sequence: options.sequence,
      turn: undefined,
      turnPermit: yield* Semaphore.make(1),
      lastMessage: undefined,
      ended: false,
      halted: false,
      userWaiting: false,
      openCalls: new Set(),
      background: 0,
      steering: false,
      applied: choiceOf(info),
      fresh: options.fresh,
      recent: undefined,
      lastTurn: undefined,
      turnToolCalls: 0,
      turnFailed: false,
      turnToolErrors: 0,
      turnStopReason: undefined,
      effortDecision: undefined,
      routedEffort: undefined,
      turnFiles: new Set(),
      limit: undefined,
      pause: undefined,
      storedRaw: undefined,
      instructions: undefined,
      currentTurnId: undefined,
      currentRequestId: undefined,
      activeAssignments: new Set(),
      turnCause: "notice",
    };
    return rt;
  });

/** The agent's harness session, which a live agent only lacks while it starts. */
export const sessionOf = (rt: Runtime) =>
  rt.wakeSession.pipe(
    Effect.andThen(
      Effect.suspend(() =>
        Effect.fromNullishOr(rt.session).pipe(
          Effect.mapError(() => notFound(`${rt.info.model} is still starting.`)),
        ),
      ),
    ),
  );

/** Settles the turn in progress, once its `TurnCompleted` arrives or the session ends. */
export const finishTurn = (rt: Runtime) =>
  rt.turn === undefined ? Effect.void : Deferred.succeed(rt.turn, undefined);

/** The catalog entry a lead's request names (an alias, or a model id), as what to start. */
export const resolveTarget = (
  entries: ReadonlyArray<CatalogEntry>,
  request: Pick<SpawnRequest, "model" | "provider" | "effort">,
): SpawnTarget | undefined => {
  const entry =
    entries.find((candidate) => candidate.alias === request.model) ??
    entries.find(
      (candidate) =>
        candidate.model === request.model &&
        (request.provider === undefined || candidate.provider === request.provider),
    );
  if (entry === undefined) return undefined;
  const effort = request.effort ?? entry.effort;
  return {
    provider: entry.provider,
    model: entry.model,
    ...(effort ? { effort } : {}),
    ...(entry.speed ? { speed: entry.speed } : {}),
  };
};
