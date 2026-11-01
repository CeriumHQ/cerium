import type { ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";

import {
  choicesOf,
  currentChoice,
  type ConfigOption,
  type ModelState,
  type SelectChoice,
  type SessionSetup,
} from "./schema.ts";

// Models and efforts from an ACP session's settings: the `model` and `thought_level` select options
// of `configOptions`, or the older `models` picker where an agent has no options.

const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Cerium's effort for an agent's thought level, by its value or name: `low`, `extra_high`, "Extra High". */
export const effortOf = (value: string): ReasoningEffort | undefined => {
  const key = value.toLowerCase().replace(/[\s_-]+/g, "");
  switch (key) {
    case "minimal":
    case "min":
      return "minimal";
    case "low":
      return "low";
    case "medium":
    case "med":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "extrahigh":
    case "veryhigh":
      return "xhigh";
    case "max":
    case "maximum":
      return "max";
    default:
      return undefined;
  }
};

const effortOfChoice = (choice: SelectChoice) => effortOf(choice.value) ?? effortOf(choice.name);

/** The efforts a thought level option offers, lowest first. */
export const effortsOf = (choices: ReadonlyArray<SelectChoice>): ReadonlyArray<ReasoningEffort> => {
  const offered = new Set(choices.flatMap((choice) => effortOfChoice(choice) ?? []));
  return EFFORTS.filter((effort) => offered.has(effort));
};

/** The choice that sets `effort`: that level, else the nearest one offered. */
export const effortValue = (
  choices: ReadonlyArray<SelectChoice>,
  effort: ReasoningEffort,
): string | undefined => {
  const want = EFFORTS.indexOf(effort);
  let best: { readonly value: string; readonly distance: number } | undefined;
  for (const choice of choices) {
    const level = effortOfChoice(choice);
    if (level === undefined) continue;
    const distance = Math.abs(EFFORTS.indexOf(level) - want);
    // Ties go to the higher level, which never answers worse than asked.
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && EFFORTS.indexOf(level) > want)
    ) {
      best = { value: choice.value, distance };
    }
  }
  return best?.value;
};

const selects = (options: ReadonlyArray<ConfigOption>) =>
  options.filter((option) => option.type === "select");

/** The option that picks the session's model. */
export const modelOption = (options: ReadonlyArray<ConfigOption>): ConfigOption | undefined =>
  selects(options).find((option) => option.category === "model") ??
  selects(options).find((option) => option.id === "model");

/** The option that sets how hard the model thinks. */
export const effortOption = (options: ReadonlyArray<ConfigOption>): ConfigOption | undefined =>
  selects(options).find((option) => option.category === "thought_level");

/** The session's current model, as its settings (or its older model picker) say. */
export const currentModel = (
  options: ReadonlyArray<ConfigOption>,
  models?: ModelState | null,
): string | undefined => {
  const option = modelOption(options);
  return option === undefined ? (models?.currentModelId ?? undefined) : currentChoice(option);
};

/** The session's current effort, as its settings say. */
export const currentEffort = (options: ReadonlyArray<ConfigOption>): ReasoningEffort | undefined => {
  const option = effortOption(options);
  const value = option === undefined ? undefined : currentChoice(option);
  return value === undefined ? undefined : effortOf(value);
};

/**
 * The models a session's settings offer, each with the efforts the thought level option offers and
 * the current one marked as the default.
 */
export const modelsOf = (provider: ProviderId, setup: SessionSetup): ReadonlyArray<ModelInfo> => {
  const options = setup.configOptions ?? [];
  const model = modelOption(options);
  const effort = effortOption(options);
  const efforts = effort === undefined ? [] : effortsOf(choicesOf(effort));
  const defaultEffort = currentEffort(options);
  const listed =
    model !== undefined
      ? choicesOf(model).map((choice) => ({
          id: choice.value,
          label: choice.name,
          description: choice.description ?? undefined,
        }))
      : (setup.models?.availableModels ?? []).map((each) => ({
          id: each.modelId,
          label: each.name,
          description: each.description ?? undefined,
        }));
  const current = currentModel(options, setup.models);
  return listed.map((each): ModelInfo => ({
    provider,
    id: each.id,
    label: each.label || each.id,
    ...(each.description ? { description: each.description } : {}),
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(each.id === current ? { isDefault: true } : {}),
  }));
};
