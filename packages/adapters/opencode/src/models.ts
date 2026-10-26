import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { call, type OpenCodeClient } from "./host.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

// OpenCode names a model `<provider>/<model>` (`opencode/big-pickle`, `anthropic/claude-sonnet-5-5`), and
// Cerium uses that as the model id. A model's effort settings are its variants: reasoning levels named
// like Cerium's efforts (`low`, `high`, `max`), plus toggles such as `none` and `thinking` that have no
// Cerium name. A provider that serves a model faster lists that as a model of its own, named with
// `-fast` (`openai/gpt-6-luna-fast`), which Cerium offers as the model's Fast speed.

/**
 * The subset of a `model.list` row Cerium reads. Its `settings`, `headers` and `body` can carry the
 * user's provider keys, so they are never decoded.
 */
export const CatalogRow = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  name: Schema.String,
  variants: Schema.Array(Schema.Struct({ id: Schema.String })),
  capabilities: Schema.Struct({ input: Schema.Array(Schema.String) }),
  status: Schema.String,
  enabled: Schema.Boolean,
  /** The model's context window, in tokens. */
  limit: Schema.optionalKey(Schema.Struct({ context: Schema.optionalKey(Schema.Finite) })),
});
export type CatalogRow = typeof CatalogRow.Type;

/** The context window of the model a session runs, when the catalog lists it with one. */
export const windowOf = (model: string, rows: ReadonlyArray<CatalogRow>): number | undefined => {
  const context = rows.find((row) => modelId(row) === model)?.limit?.context;
  return context === undefined || context < 1 ? undefined : Math.round(context);
};

/** `model.list` and `model.default` answer with their Location beside the data. */
export const ModelList = Schema.Struct({ data: Schema.Array(CatalogRow) });
export const DefaultModel = Schema.Struct({ data: Schema.NullOr(CatalogRow) });

/** Cerium's efforts, lowest first, as OpenCode's reasoning variants are named. */
const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

/** `opencode/big-pickle` → `{ providerID: "opencode", id: "big-pickle" }`. Model ids may hold slashes. */
export const parseModel = (model: string): ModelRef | undefined => {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
};

export const modelId = (row: Pick<CatalogRow, "providerID" | "id">) => `${row.providerID}/${row.id}`;

const FAST_SUFFIX = "-fast";

/** The row that runs `row`'s model at Fast speed, when its provider lists one. */
const fastRowOf = (row: Pick<CatalogRow, "providerID" | "id">, rows: ReadonlyArray<CatalogRow>) =>
  rows.find((candidate) => candidate.providerID === row.providerID && candidate.id === row.id + FAST_SUFFIX);

/** The efforts a model's variants offer, lowest first. */
export const effortsOf = (variants: ReadonlyArray<string>): ReadonlyArray<ReasoningEffort> =>
  EFFORTS.filter((effort) => variants.includes(effort));

/**
 * The variant that runs `effort`: its own name, else the nearest offered one, the lower on a tie.
 * Undefined for a model without effort variants, which runs on its provider's default.
 */
export const variantFor = (
  effort: ReasoningEffort | undefined,
  variants: ReadonlyArray<string>,
): string | undefined => {
  if (effort === undefined) return undefined;
  const offered = effortsOf(variants);
  if (offered.includes(effort)) return effort;
  const rank = EFFORTS.indexOf(effort);
  let best: ReasoningEffort | undefined;
  for (const candidate of offered) {
    const distance = Math.abs(EFFORTS.indexOf(candidate) - rank);
    if (best === undefined || distance < Math.abs(EFFORTS.indexOf(best) - rank)) best = candidate;
  }
  return best;
};

/**
 * Models a session can run: enabled ones that call tools are listed by `model.list` already. `fast`
 * is the model's Fast row, listed beside it.
 */
export const toModelInfo = (row: CatalogRow, defaultId: string | undefined, fast?: CatalogRow): ModelInfo => {
  const id = modelId(row);
  const efforts = effortsOf(row.variants.map((variant) => variant.id));
  const fastIsDefault = fast !== undefined && modelId(fast) === defaultId;
  return {
    provider: "opencode",
    id,
    label: row.name,
    description: id,
    efforts,
    ...(fast === undefined
      ? {}
      : { speeds: ["standard", "fast"], defaultSpeed: fastIsDefault ? "fast" : "standard" }),
    ...(id === defaultId || fastIsDefault ? { isDefault: true } : {}),
  };
};

/**
 * The model a session runs, with the variant for `effort`: at Fast speed, the model's Fast row where
 * its provider lists one. A model the catalog doesn't list is still passed on, without a variant:
 * OpenCode says why it can't run it when the turn starts.
 */
export const toModelRef = (
  model: string,
  effort: ReasoningEffort | undefined,
  rows: ReadonlyArray<CatalogRow>,
  speed?: ModelSpeed,
): (ModelRef & { readonly variant?: string }) | undefined => {
  const parsed = parseModel(model);
  if (parsed === undefined) return undefined;
  const fast = speed === "fast" ? fastRowOf(parsed, rows) : undefined;
  const ref = fast === undefined ? parsed : { providerID: fast.providerID, id: fast.id };
  const row = fast ?? rows.find((candidate) => modelId(candidate) === model);
  const variant =
    row === undefined
      ? undefined
      : variantFor(
          effort,
          row.variants.map((entry) => entry.id),
        );
  return variant === undefined ? ref : { ...ref, variant };
};

/**
 * The listing as Cerium offers it: deprecated models dropped, each Fast row folded into its model's
 * speeds, the default first.
 */
export const toModelInfos = (
  rows: ReadonlyArray<CatalogRow>,
  defaultRow: CatalogRow | null,
): ReadonlyArray<ModelInfo> => {
  const defaultId = defaultRow === null ? undefined : modelId(defaultRow);
  const usable = rows.filter((row) => row.enabled && row.status !== "deprecated");
  const folded = new Set(
    usable.flatMap((row) => {
      const fast = fastRowOf(row, usable);
      return fast === undefined ? [] : [modelId(fast)];
    }),
  );
  const models = usable
    .filter((row) => !folded.has(modelId(row)))
    .map((row) => toModelInfo(row, defaultId, fastRowOf(row, usable)));
  return [...models.filter((model) => model.isDefault), ...models.filter((model) => !model.isDefault)];
};

const decodeList = Schema.decodeUnknownEffect(ModelList);
const decodeDefault = Schema.decodeUnknownEffect(DefaultModel);

/** The models OpenCode would run in `directory`, and its default, from a running server. */
export const readCatalog = Effect.fn("OpenCodeAdapter.readCatalog")(function* (
  client: OpenCodeClient,
  directory: string,
) {
  const location = { location: { directory } };
  const [list, preferred] = yield* Effect.all(
    [
      call("list its models", (signal) => client.model.list(location, { signal })),
      call("name its default model", (signal) => client.model.default(location, { signal })),
    ],
    { concurrency: 2 },
  );
  const rows = yield* decodeList(list).pipe(Effect.mapError(failure("Unexpected `model.list` response")));
  const fallback = yield* decodeDefault(preferred).pipe(
    Effect.mapError(failure("Unexpected `model.default` response")),
  );
  return { rows: rows.data, defaultRow: fallback.data };
});
