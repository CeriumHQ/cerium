import type { ModelInfo, ProviderId } from "@cerium/protocol";

import { configOption, effortOf, effortsOf, selectOptions } from "./policy.ts";
import type { SessionSetup } from "./schema.ts";

// What an ACP agent offers to run, as it says on opening a session: its `model` config option (or the
// legacy `models` state), with the efforts of its `thought_level` option. The effort option describes
// the model the session runs, so every model is listed with the efforts the agent offers there.

export const modelsFromSetup = (provider: ProviderId, setup: SessionSetup): ReadonlyArray<ModelInfo> => {
  const effortOption = configOption(setup.configOptions, "thought_level");
  const efforts = effortsOf(effortOption);
  const current =
    effortOption?.type === "select"
      ? selectOptions(effortOption).find((choice) => choice.value === effortOption.currentValue)
      : undefined;
  const defaultEffort = current === undefined ? undefined : effortOf(current);
  const effortFields = {
    efforts,
    ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };

  const option = configOption(setup.configOptions, "model");
  if (option !== undefined && option.type === "select") {
    return selectOptions(option).flatMap((choice): ReadonlyArray<ModelInfo> =>
      choice.value === ""
        ? []
        : [
            {
              provider,
              id: choice.value,
              label: choice.name.trim() || choice.value,
              ...(choice.description ? { description: choice.description } : {}),
              ...effortFields,
              ...(choice.value === option.currentValue ? { isDefault: true } : {}),
            },
          ],
    );
  }
  const legacy = setup.models;
  if (legacy !== undefined && legacy !== null && Array.isArray(legacy.availableModels)) {
    return legacy.availableModels.flatMap((entry): ReadonlyArray<ModelInfo> =>
      entry.modelId === ""
        ? []
        : [
            {
              provider,
              id: entry.modelId,
              label: entry.name?.trim() || entry.modelId,
              ...(entry.description ? { description: entry.description } : {}),
              ...effortFields,
              ...(entry.modelId === legacy.currentModelId ? { isDefault: true } : {}),
            },
          ],
    );
  }
  return [];
};
