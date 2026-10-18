import type { AccessMode, ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { modelsAtom } from "../../backend/atoms.ts";

/** Model ids are only unique within a provider, so choices are remembered by both. */
export const modelKey = (model: Pick<ModelInfo, "provider" | "id">) => `${model.provider}/${model.id}`;

/** Every model the installed harnesses offer, in provider order. */
export const useModels = (): ReadonlyArray<ModelInfo> =>
  AsyncResult.getOrElse(useAtomValue(modelsAtom), () => []);

/** The model a provider's harness uses when none is named, or its first. */
export const defaultModel = (
  models: ReadonlyArray<ModelInfo>,
  provider: ProviderId,
): ModelInfo | undefined => {
  const offered = models.filter((model) => model.provider === provider);
  return offered.find((model) => model.isDefault === true) ?? offered[0];
};

/**
 * The chosen model while its harness can run it; otherwise the first usable harness's own default.
 * Undefined until some harness has offered a model.
 */
export const pickModel = (
  models: ReadonlyArray<ModelInfo>,
  key: string,
  available: ReadonlySet<ProviderId>,
): ModelInfo | undefined => {
  const usable = models.filter((model) => available.has(model.provider));
  const chosen = models.find((model) => modelKey(model) === key);
  if (chosen !== undefined && (available.has(chosen.provider) || usable.length === 0)) return chosen;
  const provider = (usable[0] ?? models[0])?.provider;
  return provider === undefined ? undefined : defaultModel(models, provider);
};

/** The effort a model runs at: the chosen one when it has it, else its default or strongest. */
export const effortFor = (model: ModelInfo, effort: ReasoningEffort): ReasoningEffort | undefined =>
  model.efforts.includes(effort) ? effort : (model.defaultEffort ?? model.efforts.at(-1));

export const effortLabel: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The access modes a person picks from. `ask` and `acceptEdits` stay in the protocol for threads and
 * agents that already run with them, but aren't offered.
 */
export const accessOptions: ReadonlyArray<{
  readonly value: AccessMode;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "auto", label: "Auto", description: "Edits and runs what a reviewer model judges safe" },
  { value: "readOnly", label: "Read only", description: "Reads and searches; never edits or runs commands" },
  {
    value: "fullAccess",
    label: "Full access",
    description: "Edits and runs anything without asking, outside the sandbox",
  },
];
