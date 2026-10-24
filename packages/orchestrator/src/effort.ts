import type { ReasoningEffort } from "@cerium/protocol";
import { Context, Duration, Effect, Layer, Schema } from "effect";

import { truncate } from "./prompts.ts";

// The effort router: on agents set to Auto, a decision model picks each turn's reasoning effort from
// the turn and the conversation just before it. Cerium only asks; the decision model is the user's
// (`EffortDecider`, through their own key).

/** How long a turn waits for the decision model before keeping its level. */
export const DECISION_TIMEOUT = Duration.millis(1500);

/** Below this confidence in its likeliest level, the decision model's pick isn't taken. */
export const CONFIDENCE_FLOOR = 0.5;

/** How much of the turn, and of each earlier exchange, the decision model reads. */
export const TURN_CHARS = 4_000;
export const EXCHANGE_CHARS = 1_000;
/** How many exchanges before the turn the decision model reads. */
export const RECENT_EXCHANGES = 2;

/** One earlier exchange: what the agent was sent, and its final reply. */
export interface Exchange {
  readonly sent: string;
  readonly replied: string;
}

/** How the agent's previous turn went. */
export interface TurnFacts {
  readonly toolCalls: number;
  readonly seconds: number;
  readonly failed: boolean;
  readonly filesChanged: number;
}

/** What the decision model reads: no file contents, tool output, attachments or system prompt. */
export interface EffortState {
  readonly turn: { readonly from: "user" | "agent"; readonly text: string };
  readonly recent: ReadonlyArray<Exchange>;
  readonly previousTurn?: TurnFacts;
}

/** A turn to pick an effort for, among `levels`, lowest first. */
export interface EffortQuestion {
  readonly levels: readonly [ReasoningEffort, ...Array<ReasoningEffort>];
  readonly state: EffortState;
}

export interface EffortAnswer {
  /** The probability of each of the question's levels, in its order. */
  readonly probabilities: ReadonlyArray<number>;
  /** How sure the decision model is, from 0 to 1. */
  readonly confidence: number;
  readonly costUsd?: number;
}

/** The decision model gave no usable answer; `message` is written for the user. */
export class EffortDecisionError extends Schema.TaggedError<EffortDecisionError>()("EffortDecisionError", {
  message: Schema.String,
}) {}

/** The decision model the router asks; absent from builds without one, where the router never runs. */
export class EffortDecider extends Context.Service<
  EffortDecider,
  {
    /** Whether the decision model can be asked: its key is saved. */
    readonly ready: Effect.Effect<boolean>;
    decide(question: EffortQuestion): Effect.Effect<EffortAnswer, EffortDecisionError>;
  }
>()("cerium/orchestrator/EffortDecider") {
  static readonly none: EffortDecider["Service"] = {
    ready: Effect.succeed(false),
    decide: () => Effect.fail(new EffortDecisionError({ message: "No decision model is set up." })),
  };
  static readonly layerNone = Layer.succeed(EffortDecider, EffortDecider.none);
}

/** What each level is for, as the decision model reads it. */
export const LEVEL_GUIDE: Record<ReasoningEffort, string> = {
  minimal: "an acknowledgement, a yes or no, or repeating something already known",
  low: "a quick factual answer, a one-line change, or a routine step whose path is obvious",
  medium: "a contained change or question that takes some reading and a few steps",
  high: "multi-step work across several files, debugging, or a design choice with trade-offs",
  xhigh: "long, open-ended agentic work, or a subtle bug that needs deep investigation",
  max: "the hardest problems, where thoroughness matters far more than time or cost",
};

export const DECISION_INSTRUCTIONS =
  "How much reasoning effort should a coding agent spend on its next turn? `turn` is what it was " +
  "just sent, by the user or by another agent; `recent` the exchanges just before; `previousTurn` " +
  "how its last turn went. Lower effort is faster and cheaper: pick the lowest level that will do " +
  "this turn well.";

/**
 * The level the decision model found likeliest, ties going to the lower one; `undefined` when it gave
 * no probability for any level.
 */
export const likeliest = (
  levels: ReadonlyArray<ReasoningEffort>,
  probabilities: ReadonlyArray<number>,
): ReasoningEffort | undefined => {
  let best: number | undefined;
  probabilities.forEach((probability, index) => {
    if (index >= levels.length || !Number.isFinite(probability)) return;
    if (best === undefined || probability > (probabilities[best] ?? 0)) best = index;
  });
  return best === undefined ? undefined : levels[best];
};

/** The router's state for a turn, cut to the sizes the decision model reads. */
export const effortState = (
  turn: EffortState["turn"],
  recent: ReadonlyArray<Exchange>,
  previousTurn: TurnFacts | undefined,
): EffortState => ({
  turn: { from: turn.from, text: truncate(turn.text, TURN_CHARS) },
  recent: recent.slice(-RECENT_EXCHANGES).map((exchange) => ({
    sent: truncate(exchange.sent, EXCHANGE_CHARS),
    replied: truncate(exchange.replied, EXCHANGE_CHARS),
  })),
  ...(previousTurn === undefined ? {} : { previousTurn }),
});
