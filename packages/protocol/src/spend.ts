import { Effect, Schema } from "effect";

import { ReasoningEffort, StoredSpeed } from "./capabilities.ts";
import { LenientArray } from "./compat.ts";
import { AgentId, EpochMillis, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";

// What agents have used, summed from the `UsageReported` event each turn ends with, for Settings →
// Cost. Tokens are what the harness counted; cost is only what it reported, never priced by Cerium.

/** What a group of turns used. */
export const SpendTotals = Schema.Struct({
  /** Input the harness read fresh, without cache reads (`UsageReported.inputTokens`). */
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  turns: NonNegativeInt,
  /** The turns whose cost the harness reported; the rest cost nothing it said. */
  pricedTurns: NonNegativeInt,
  /** The reported costs summed, in dollars; 0 when `pricedTurns` is. */
  costUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SpendTotals = typeof SpendTotals.Type;

export const ProviderSpend = Schema.Struct({ ...SpendTotals.fields, provider: ProviderId });
export type ProviderSpend = typeof ProviderSpend.Type;

export const ModelSpend = Schema.Struct({
  ...SpendTotals.fields,
  provider: ProviderId,
  model: Schema.NonEmptyString,
});
export type ModelSpend = typeof ModelSpend.Type;

export const ThreadSpend = Schema.Struct({
  ...SpendTotals.fields,
  threadId: ThreadId,
  title: Schema.String,
});
export type ThreadSpend = typeof ThreadSpend.Type;

/**
 * The turns that ran with one model at one reasoning effort and speed. `effort` is absent where the
 * model has no effort setting or ran at its harness's own level, `speed` where it has no speed
 * setting or none was ever picked.
 */
export const ComboSpend = Schema.Struct({
  ...SpendTotals.fields,
  provider: ProviderId,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
  speed: Schema.optionalKey(StoredSpeed),
});
export type ComboSpend = typeof ComboSpend.Type;

export const AgentSpend = Schema.Struct({
  ...SpendTotals.fields,
  agentId: AgentId,
  threadId: ThreadId,
  /** The thread's title. */
  title: Schema.String,
  role: Schema.NonEmptyString,
  provider: ProviderId,
  /** The model it ran most, when it ran several. */
  model: Schema.NonEmptyString,
});
export type AgentSpend = typeof AgentSpend.Type;

/** One stretch of time, from `start` to the next bucket's. */
export const SpendBucket = Schema.Struct({ ...SpendTotals.fields, start: EpochMillis });
export type SpendBucket = typeof SpendBucket.Type;

/** Where a report's time is cut, as the asking side's calendar has it: at least two, ascending. */
export const SpendEdges = Schema.Array(EpochMillis).check(Schema.isMinLength(2), Schema.isMaxLength(64));
export type SpendEdges = typeof SpendEdges.Type;

/**
 * The use between the first and last of the request's edges, in a bucket for each pair of
 * neighbours. Threads and agents are the biggest few by tokens; deleted threads are not counted.
 */
export const SpendReport = Schema.Struct({
  totals: SpendTotals,
  buckets: LenientArray(SpendBucket),
  providers: LenientArray(ProviderSpend),
  models: LenientArray(ModelSpend),
  threads: LenientArray(ThreadSpend),
  agents: LenientArray(AgentSpend),
  /** Empty from a backend that predates combos. */
  combos: LenientArray(ComboSpend).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type SpendReport = typeof SpendReport.Type;
