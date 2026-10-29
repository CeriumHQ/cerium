import {
  rosterMembers,
  type AgentEvent,
  type LimitPaused,
  type ModelInfo,
  type ModelSpeed,
  type ProviderId,
  type ReasoningEffort,
  type RosterSettings,
} from "@cerium/protocol";

import { supportedLevel } from "./effort.ts";

// What a harness's limit running out does to a thread, kept apart from the orchestrator so it can
// be tested without sessions: how long to wait, which harnesses are out, and who takes over.

/** The events these decisions read; the rest of a lead's history says nothing about limits. */
export const LIMIT_TAGS = [
  "LimitReached",
  "LimitPaused",
  "LimitResumed",
  "LeadHandedOff",
  "ConversationRewound",
  "MessageQueued",
  "TurnInput",
  "TurnCompleted",
] as const;

/** The harnesses that ran out since a turn last completed, and how many pauses that took. */
export interface LimitEpisode {
  readonly providers: ReadonlySet<ProviderId>;
  readonly pauses: number;
}

/**
 * Where a lead stands with its limits, from its events (`LIMIT_TAGS`): the harnesses that ran out
 * since a turn last completed, so a thread moved on from one doesn't come back to it while the rest
 * are out too, and the pauses since, so waiting for a limit that never lifts gives up.
 */
export const limitEpisode = (events: ReadonlyArray<AgentEvent>): LimitEpisode => {
  const providers = new Set<ProviderId>();
  let pauses = 0;
  for (const { payload } of events.toReversed()) {
    if (payload._tag === "TurnCompleted" && payload.stopReason === "completed") break;
    if (payload._tag === "ConversationRewound") break;
    if (payload._tag === "LimitReached") providers.add(payload.provider);
    if (payload._tag === "LimitPaused") pauses += 1;
  }
  return { providers, pauses };
};

/**
 * The pause a lead is still in, from its events (`LIMIT_TAGS`): the latest `LimitPaused` unless
 * anything since ended it: a `LimitResumed`, the user's message or a turn it started, a handoff or a
 * rewind.
 */
export const openPause = (events: ReadonlyArray<AgentEvent>): LimitPaused | undefined => {
  for (const { payload } of events.toReversed()) {
    switch (payload._tag) {
      case "LimitPaused":
        return payload;
      case "LimitResumed":
      case "TurnInput":
      case "MessageQueued":
      case "LeadHandedOff":
      case "ConversationRewound":
        return undefined;
      default:
        break;
    }
  }
  return undefined;
};

/** How long a pause lasts when the harness doesn't say. */
export interface PauseTiming {
  /** How long to wait to try again when the harness reports no reset time; times the pause's number. */
  readonly retry: number;
  /** How long after the reported reset to wait, so the harness has surely counted it. */
  readonly margin: number;
}

/**
 * When a pause ends: shortly after the limit's reported reset, else a guess that grows with each
 * pause in a row. A reset already past (a clock apart, or a limit that renewed and ran out again)
 * is no better than none.
 */
export const pauseEnd = (
  hit: { readonly resetsAt?: number },
  now: number,
  pauses: number,
  timing: PauseTiming,
): { readonly resumeAt: number; readonly reported: boolean } =>
  hit.resetsAt !== undefined && hit.resetsAt > now
    ? { resumeAt: hit.resetsAt + timing.margin, reported: true }
    : { resumeAt: now + timing.retry * (pauses + 1), reported: false };

/** A model of another harness a lead can be handed to, as the roster offers it. */
export interface FailoverTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly speed?: ModelSpeed;
}

/**
 * The next model on the roster from a harness that hasn't run out: the first, in the roster's order,
 * whose harness isn't the lead's or any in `tried`, and that Cerium has an adapter for. It keeps the
 * lead's effort where the model has it, else the model's default.
 */
export const failoverTarget = (
  roster: RosterSettings,
  offered: ReadonlyArray<ModelInfo>,
  lead: { readonly provider: ProviderId; readonly effort?: ReasoningEffort },
  tried: ReadonlySet<ProviderId>,
  installed: (provider: ProviderId) => boolean,
): FailoverTarget | undefined => {
  const next = rosterMembers(roster, offered).find(
    ({ model }) =>
      model.provider !== lead.provider && !tried.has(model.provider) && installed(model.provider),
  );
  if (next === undefined) return undefined;
  const [lowest, ...higher] = next.model.efforts;
  const effort =
    lead.effort !== undefined && lowest !== undefined
      ? supportedLevel([lowest, ...higher], lead.effort)
      : next.model.defaultEffort;
  return {
    provider: next.model.provider,
    model: next.model.id,
    ...(effort ? { effort } : {}),
    ...(next.speed ? { speed: next.speed } : {}),
  };
};

/** What the lead hears when its pause ends. */
export const resumeNotice = (): string =>
  "Your usage limit has reset. It cut your last turn off: carry on from there, don't start over.";

/** What the lead hears once it is moved to another harness because the first ran out. */
export const failoverNotice = (from: string): string =>
  `${from} ran out of usage in the middle of your last turn. Carry on from where it stopped, using the` +
  " conversation and the work it had done so far, without starting the task over.";
