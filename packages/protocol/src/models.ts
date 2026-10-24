import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { ProviderId } from "./ids.ts";

/** A model the user's installed harness offers, as that harness reports it. */
export const ModelInfo = Schema.Struct({
  provider: ProviderId,
  /** What sessions are started with; the harness's own model id or alias. */
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  /** Efforts the model accepts, lowest first. Empty when the harness has no effort setting for it. */
  efforts: Schema.Array(ReasoningEffort),
  defaultEffort: Schema.optionalKey(ReasoningEffort),
  /**
   * A live check measured the provider's prompt cache surviving an effort switch mid-session on this
   * model, so the effort router may change it every turn. Absent: not measured, or the cache restarts.
   */
  cacheSafeEffort: Schema.optionalKey(Schema.Boolean),
  /** The model the harness picks when none is named. */
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type ModelInfo = typeof ModelInfo.Type;
