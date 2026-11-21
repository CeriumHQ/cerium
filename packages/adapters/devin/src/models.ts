import type { ModelInfo, ModelSpeed, ReasoningEffort } from "@cerium/protocol";

import { array, record, string } from "./acp.ts";
import { PROVIDER } from "./manifest.ts";

export interface ConfigChoice {
  readonly value: string;
  readonly name?: string;
  readonly description?: string;
  /** Devin's own `cognition.ai/supportsImages` for a model. */
  readonly images?: boolean;
}

export interface ConfigOption {
  readonly id: string;
  readonly currentValue: string;
  readonly options: ReadonlyArray<ConfigChoice>;
}

/** A session's select options (`mode`, `model`, `thought_level`, `speed`), as ACP reports them. */
export const readConfigOptions = (value: unknown): ReadonlyArray<ConfigOption> =>
  array(value).flatMap((entry) => {
    const option = record(entry);
    const id = string(option?.["id"]);
    const currentValue = string(option?.["currentValue"]);
    if (id === undefined || currentValue === undefined) return [];
    const options = array(option?.["options"]).flatMap((item): ReadonlyArray<ConfigChoice> => {
      const choice = record(item);
      const value = string(choice?.["value"]);
      if (value === undefined) return [];
      const name = string(choice?.["name"]);
      const description = string(choice?.["description"]);
      const images = record(choice?.["_meta"])?.["cognition.ai/supportsImages"];
      return [
        {
          value,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(typeof images === "boolean" ? { images } : {}),
        },
      ];
    });
    return [{ id, currentValue, options }];
  });

export const configOption = (config: ReadonlyArray<ConfigOption>, id: string) =>
  config.find((option) => option.id === id);

const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];
const SPEEDS: ReadonlyArray<ModelSpeed> = ["standard", "fast", "ultrafast"];

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
