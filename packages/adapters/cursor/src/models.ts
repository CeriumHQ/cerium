import { Cursor, type ModelListItem, type ModelParameterDefinition, type ModelSelection } from "@cursor/sdk";
import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo, ReasoningEffort } from "@cerium/protocol";
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

export const toModelInfo = (model: ModelListItem): ModelInfo => {
  const parameter = effortParameter(model);
  const efforts = parameter === undefined ? [] : effortValues(parameter).map(([effort]) => effort);
  const defaultValue =
    parameter === undefined
      ? undefined
      : model.variants
          ?.find((variant) => variant.isDefault === true)
          ?.params.find((param) => param.id === parameter.id)?.value;
  const defaultEffort = defaultValue === undefined ? undefined : toCeriumEffort(defaultValue);
  return {
    provider: "cursor",
    id: model.id,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts,
    ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };
};

/**
 * Builds the SDK's model selection from a Cerium model id and effort. Ids may carry parameters in the
 * CLI's bracket form (`gpt-5[effort=high,fast=true]`); `effort` replaces any effort given there and is
 * clamped to the closest level the model offers. Models without an effort parameter ignore it.
 */
export const toModelSelection = (
  modelId: string,
  effort: ReasoningEffort | undefined,
  catalog: ReadonlyArray<ModelListItem>,
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
  const params =
    parameter === undefined || value === undefined
      ? given
      : [...given.filter((param) => param.id !== parameter.id), { id: parameter.id, value }];
  return params.length > 0 ? { id, params } : { id };
};
