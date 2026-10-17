import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { openHost, query } from "./host.ts";
import { ceriumEffort, ceriumEfforts } from "./policy.ts";

/** The subset of a `model/list` row Cerium reads (tdd SS3.10). */
export const CatalogRow = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.String,
  description: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  isActive: Schema.optionalKey(Schema.Boolean),
  providerId: Schema.optionalKey(Schema.String),
  defaultReasoningEffort: Schema.optionalKey(Schema.String),
  variants: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")])),
});
export type CatalogRow = typeof CatalogRow.Type;

export const ModelList = Schema.Struct({ models: Schema.Array(CatalogRow) });

export const toModelInfo = (row: CatalogRow): ModelInfo => {
  const defaultEffort = ceriumEffort(row.defaultReasoningEffort);
  return {
    provider: "muse",
    id: row.modelId,
    label: row.displayLabel,
    ...(row.description ? { description: row.description } : {}),
    efforts: ceriumEfforts(row.variants),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(row.isDefault ? { isDefault: true } : {}),
  };
};

/** Asks the user's `muse` for its model catalog: the ids `session/start` and `session/setModel` accept. */
export const listMuseModels = Effect.fn("MuseAdapter.listModels")(function* (executablePath: string) {
  const host = yield* openHost(executablePath, ["serve", "--no-session-log"], {
    capabilities: { userInputDialogs: false },
  });
  const answer = yield* query(host, "model/list");
  const list = yield* Schema.decodeUnknownEffect(ModelList)(answer).pipe(
    Effect.mapError(
      (cause) => new HarnessFailure({ provider: "muse", message: "Unexpected `model/list` answer", cause }),
    ),
  );
  return list.models.map(toModelInfo);
}, Effect.scoped);
