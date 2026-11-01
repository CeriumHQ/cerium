import { effortOf, metaAt, type Initialized } from "@cerium/adapter-acp";
import { LenientArray, type ModelInfo, type ReasoningEffort } from "@cerium/protocol";
import { Option, Schema } from "effect";

// Grok's models, as its agent lists them when it starts (`initialize`'s `_meta.modelState`): each with
// the efforts it takes and its context window, and the one it runs when none is named.

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Effort = Schema.Struct({ value: Schema.String, default: nullable(Schema.Boolean) });

export const GrokModel = Schema.Struct({
  modelId: Schema.String,
  name: nullable(Schema.String),
  description: nullable(Schema.String),
  _meta: nullable(
    Schema.Struct({
      totalContextTokens: nullable(Schema.Finite),
      supportsReasoningEffort: nullable(Schema.Boolean),
      /** The effort Grok runs the model at now, as the user's settings say. */
      reasoningEffort: nullable(Schema.String),
      reasoningEfforts: nullable(LenientArray(Effort)),
    }),
  ),
});
export type GrokModel = typeof GrokModel.Type;

export const ModelState = Schema.Struct({
  currentModelId: nullable(Schema.String),
  availableModels: LenientArray(GrokModel),
});
export type ModelState = typeof ModelState.Type;

const decodeState = Schema.decodeUnknownOption(ModelState);

/** The model list the agent started with, when it gave one. */
export const modelStateOf = (initialized: Initialized): ModelState | undefined =>
  Option.getOrUndefined(decodeState(metaAt(initialized._meta, "modelState")));

const ORDER: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

const effortsOf = (model: GrokModel): ReadonlyArray<ReasoningEffort> => {
  if (model._meta?.supportsReasoningEffort === false) return [];
  const offered = new Set(
    (model._meta?.reasoningEfforts ?? []).flatMap((each) => effortOf(each.value) ?? []),
  );
  return ORDER.filter((effort) => offered.has(effort));
};

const defaultEffortOf = (model: GrokModel): ReasoningEffort | undefined => {
  const configured = model._meta?.reasoningEffort;
  const marked = (model._meta?.reasoningEfforts ?? []).find((each) => each.default === true)?.value;
  return (
    (configured === undefined || configured === null ? undefined : effortOf(configured)) ??
    (marked === undefined ? undefined : effortOf(marked))
  );
};

export const toModelInfos = (state: ModelState): ReadonlyArray<ModelInfo> =>
  state.availableModels.map((model): ModelInfo => {
    const efforts = effortsOf(model);
    const defaultEffort = efforts.length === 0 ? undefined : defaultEffortOf(model);
    const description = model.description?.trim();
    return {
      provider: "grok",
      id: model.modelId,
      label: model.name?.trim() || model.modelId,
      ...(description ? { description } : {}),
      efforts,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(model.modelId === state.currentModelId ? { isDefault: true } : {}),
    };
  });

/** The context window of `modelId`, as the agent listed it. */
export const contextWindowOf = (initialized: Initialized, modelId: string): number | undefined => {
  const window = modelStateOf(initialized)?.availableModels.find((model) => model.modelId === modelId)?._meta
    ?.totalContextTokens;
  return window === undefined || window === null || window < 1 ? undefined : window;
};

/** The lowest effort `modelId` takes, for Cerium's quick jobs. */
export const lowestEffort = (state: ModelState | undefined, modelId: string): ReasoningEffort | undefined => {
  const model = state?.availableModels.find((each) => each.modelId === modelId);
  return model === undefined ? undefined : effortsOf(model)[0];
};
