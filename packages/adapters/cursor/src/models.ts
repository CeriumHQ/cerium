import { Cursor, type ModelListItem, type ModelParameterDefinition, type ModelSelection } from "@cursor/sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Effect } from "effect";

const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The models the user's account offers. The SDK resolves its own credentials for the request. */
export const fetchModelCatalog = Effect.tryPromise({
  try: () => Cursor.models.list(),
  catch: (cause) =>
    new HarnessFailure({ provider: "cursor", message: "Could not list Cursor models", cause }),
});

/** Reads a Cursor parameter value ("xhigh", "Extra High", "maximum", …) as a Cerium effort. */
export const toCeriumEffort = (value: string): ReasoningEffort | undefined => {
  const word = value.toLowerCase().replaceAll(/[^a-z]/g, "");
  if (word === "extrahigh" || word === "veryhigh") return "xhigh";
  if (word === "maximum") return "max";
  if (word === "min") return "minimal";
  return EFFORTS.find((effort) => effort === word);
};

/** Cerium efforts a parameter accepts, lowest first, each with the Cursor value that sets it. */
const effortValues = (parameter: ModelParameterDefinition): ReadonlyArray<[ReasoningEffort, string]> => {
  const values = new Map<ReasoningEffort, string>();
  for (const { value } of parameter.values) {
    const effort = toCeriumEffort(value);
    if (effort !== undefined && !values.has(effort)) values.set(effort, value);
  }
  return EFFORTS.flatMap((effort) => {
    const value = values.get(effort);
    return value === undefined ? [] : [[effort, value] as [ReasoningEffort, string]];
  });
};

/**
 * The parameter that sets a model's reasoning level. Ids vary by model ("effort", "reasoning",
 * "thinking", …), so it is recognised by id or display name, the way Cursor's own clients do, and
 * must offer at least one level (an on/off "thinking" switch is not an effort).
 */
export const effortParameter = (model: ModelListItem): ModelParameterDefinition | undefined =>
  model.parameters?.find((parameter) => {
    const id = parameter.id.trim().toLowerCase();
    const name = (parameter.displayName ?? "").toLowerCase();
    const named =
      ["effort", "reasoning", "thinking", "thought_level", "reasoning_effort"].includes(id) ||
      ["effort", "reasoning", "thinking", "thought"].some((word) => name.includes(word));
    return named && effortValues(parameter).length > 0;
  });

/** The supported effort closest to the requested one; ties go to the lower effort. */
export const clampEffort = (
  requested: ReasoningEffort,
  supported: ReadonlyArray<ReasoningEffort>,
): ReasoningEffort | undefined => {
  const distance = (effort: ReasoningEffort) =>
    Math.abs(EFFORTS.indexOf(effort) - EFFORTS.indexOf(requested));
  let best: ReasoningEffort | undefined;
  for (const effort of supported) {
    if (best === undefined || distance(effort) < distance(best)) best = effort;
  }
  return best;
};

/**
 * The parameter that runs a model on Cursor's Fast tier, an on/off switch on the models that have
 * one. Some default to it on (Composer, Grok), so standard speed has to be asked for.
 */
export const speedParameter = (model: ModelListItem): ModelParameterDefinition | undefined =>
  model.parameters?.find(
    (parameter) =>
      parameter.id === SPEED_PARAMETER &&
      parameter.values.some(({ value }) => value === "true") &&
      parameter.values.some(({ value }) => value === "false"),
  );

const SPEED_PARAMETER = "fast";

/** The value a model's default variant gives a parameter: what runs when Cerium names none. */
const defaultValueOf = (model: ModelListItem, parameter: ModelParameterDefinition | undefined) =>
  parameter === undefined
    ? undefined
    : model.variants
        ?.find((variant) => variant.isDefault === true)
        ?.params.find((param) => param.id === parameter.id)?.value;

export const toModelInfo = (model: ModelListItem): ModelInfo => {
  const parameter = effortParameter(model);
  const efforts = parameter === undefined ? [] : effortValues(parameter).map(([effort]) => effort);
  const defaultValue = defaultValueOf(model, parameter);
  const defaultEffort = defaultValue === undefined ? undefined : toCeriumEffort(defaultValue);
  const speed = speedParameter(model);
  return {
    provider: "cursor",
    id: model.id,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts,
    ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
    ...(speed === undefined
      ? {}
      : {
          speeds: ["standard", "fast"],
          defaultSpeed: defaultValueOf(model, speed) === "true" ? "fast" : "standard",
        }),
  };
};

/**
 * Builds the SDK's model selection from a Cerium model id, effort and speed. Ids may carry parameters
 * in the CLI's bracket form (`gpt-5[effort=high,fast=true]`); `effort` and `speed` replace any given
 * there, the effort clamped to the closest level the model offers. Models without an effort parameter
 * ignore it; a speed other than `fast` runs a model with a Fast switch at standard speed.
 */
export const toModelSelection = (
  modelId: string,
  effort: ReasoningEffort | undefined,
  catalog: ReadonlyArray<ModelListItem>,
  speed?: ModelSpeed,
): ModelSelection => {
  const match = /^([^[\]]+)\[([^\]]*)\]$/.exec(modelId.trim());
  const id = (match?.[1] ?? modelId).trim();
  const given = (match?.[2] ?? "").split(",").flatMap((pair) => {
    const [key, value] = pair.split("=").map((part) => part.trim());
    return key && value ? [{ id: key, value }] : [];
  });

  const model = catalog.find((entry) => entry.id === id || entry.aliases?.includes(id) === true);
  const parameter = model === undefined ? undefined : effortParameter(model);
  const values = parameter === undefined ? [] : effortValues(parameter);
  const chosen =
    effort === undefined
      ? undefined
      : clampEffort(
          effort,
          values.map(([level]) => level),
        );
  const value = values.find(([level]) => level === chosen)?.[1];
  const withEffort =
    parameter === undefined || value === undefined
      ? given
      : [...given.filter((param) => param.id !== parameter.id), { id: parameter.id, value }];
  const fast = model === undefined || speed === undefined ? undefined : speedParameter(model);
  const params =
    fast === undefined
      ? withEffort
      : [
          ...withEffort.filter((param) => param.id !== fast.id),
          { id: fast.id, value: speed === "fast" ? "true" : "false" },
        ];
  return params.length > 0 ? { id, params } : { id };
};
