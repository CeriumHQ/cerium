import { EFFORTS, SPEEDS, configOption, type ConfigChoice, type ConfigOption } from "@cerium/acp";
import type { ModelInfo, ModelSpeed, ReasoningEffort } from "@cerium/protocol";

import { PROVIDER } from "./manifest.ts";

/** Devin's own `cognition.ai/supportsImages` for a model. */
export const acceptsImages = (choice: ConfigChoice | undefined) => {
  const images = choice?.meta?.["cognition.ai/supportsImages"];
  return typeof images === "boolean" ? images : undefined;
};

/** What a session offers for the model it is on: Devin lists efforts and speeds per model. */
export interface Variant {
  readonly efforts: ReadonlyArray<ReasoningEffort>;
  readonly defaultEffort?: ReasoningEffort;
  readonly speeds?: ReadonlyArray<ModelSpeed>;
  readonly defaultSpeed?: ModelSpeed;
}

export const variantOf = (config: ReadonlyArray<ConfigOption>): Variant => {
  const thought = configOption(config, "thought_level");
  const speed = configOption(config, "speed");
  // Devin's `none` turns reasoning off, which Cerium has no effort for.
  const efforts = EFFORTS.filter((effort) => thought?.options.some(({ value }) => value === effort));
  const defaultEffort = efforts.find((effort) => effort === thought?.currentValue);
  const speeds = SPEEDS.filter((value) => speed?.options.some((option) => option.value === value));
  const choice = speeds.length > 1 && speeds.includes("standard");
  const defaultSpeed = speeds.find((value) => value === speed?.currentValue);
  return {
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(choice ? { speeds } : {}),
    ...(choice && defaultSpeed !== undefined ? { defaultSpeed } : {}),
  };
};

export const modelIds = (config: ReadonlyArray<ConfigOption>) =>
  configOption(config, "model")?.options.map(({ value }) => value) ?? [];

/**
 * The account's models, with each one's efforts and speeds where a sweep has read them. The session's
 * own model is always known; a model the sweep hasn't reached yet lists no efforts until it has.
 */
export const toModelInfos = (
  config: ReadonlyArray<ConfigOption>,
  variants: ReadonlyMap<string, Variant>,
): ReadonlyArray<ModelInfo> => {
  const model = configOption(config, "model");
  if (model === undefined) return [];
  return model.options.map(({ value, name, description }) => {
    const isDefault = value === model.currentValue;
    const variant = (isDefault ? variantOf(config) : undefined) ?? variants.get(value) ?? { efforts: [] };
    return {
      provider: PROVIDER,
      id: value,
      label: name ?? value,
      ...(description === undefined ? {} : { description }),
      ...variant,
      ...(isDefault ? { isDefault } : {}),
    };
  });
};
