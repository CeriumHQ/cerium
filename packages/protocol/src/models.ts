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
  /** The model the harness picks when none is named. */
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type ModelInfo = typeof ModelInfo.Type;
