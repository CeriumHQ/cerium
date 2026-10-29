import { Schema } from "effect";

import { UiEvents } from "./sync.ts";
import { EventId } from "./ids.ts";

/** Display order is total across agents, including events imported with identical times/sequences. */
export const HistoryCursor = Schema.Struct({ at: Schema.Finite, sequence: Schema.Int, id: EventId });
export type HistoryCursor = typeof HistoryCursor.Type;

export const HistoryRequest = Schema.Struct({
  before: Schema.optionalKey(HistoryCursor),
  /** Durable append position, independent of display time (imports can arrive late). */
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 }))),
});
export type HistoryRequest = typeof HistoryRequest.Type;

export const HistoryPage = Schema.Struct({
  events: UiEvents,
  before: Schema.optionalKey(HistoryCursor),
  after: Schema.Int,
  more: Schema.Boolean,
});
export type HistoryPage = typeof HistoryPage.Type;

/** Cloud batches are immutable, append-ordered and at most MAX_SYNC_BATCH_BYTES each. */
export const CloudHistoryPage = Schema.Struct({
  events: UiEvents,
  before: Schema.optionalKey(Schema.Int),
  more: Schema.Boolean,
});
export type CloudHistoryPage = typeof CloudHistoryPage.Type;
