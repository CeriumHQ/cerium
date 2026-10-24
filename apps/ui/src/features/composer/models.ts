import type {
  AccessMode,
  HarnessLimit,
  HarnessStatus,
  ModelInfo,
  ProviderId,
  ReasoningEffort,
} from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { modelsAtom } from "../../backend/atoms.ts";
import { providerName } from "../threads/model.ts";

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

/**
 * The models that match what's typed, best first: labels that start with it, labels that contain it,
 * then models whose harness, label and id together hold every word typed ("cursor opus"). Each group
 * keeps the list's own order.
 */
export const findModels = (models: ReadonlyArray<ModelInfo>, query: string): ReadonlyArray<ModelInfo> => {
  const typed = query.trim().toLowerCase();
  if (typed === "") return models;
  const words = typed.split(/\s+/);
  const rank = (model: ModelInfo) => {
    const label = model.label.toLowerCase();
    if (label.startsWith(typed)) return 0;
    if (label.includes(typed)) return 1;
    const haystack = `${providerName[model.provider]} ${model.label} ${model.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word)) ? 2 : undefined;
  };
  return models
    .flatMap((model) => {
      const score = rank(model);
      return score === undefined ? [] : [{ model, score }];
    })
    .sort((a, b) => a.score - b.score)
    .map(({ model }) => model);
};

/** How many models one message can start threads with at once, side by side. */
export const MAX_AGENTS = 4;

/** The chosen models, by `modelKey`, whose harnesses can run them: each once, in the order chosen. */
export const pickModels = (
  models: ReadonlyArray<ModelInfo>,
  keys: ReadonlyArray<string>,
  available: ReadonlySet<ProviderId>,
): ReadonlyArray<ModelInfo> =>
  keys
    .filter((key, index) => keys.indexOf(key) === index)
    .flatMap((key) => {
      const model = models.find((candidate) => modelKey(candidate) === key);
      return model !== undefined && available.has(model.provider) ? [model] : [];
    })
    .slice(0, MAX_AGENTS);

const effortOrder = (): ReadonlyArray<ReasoningEffort> => Object.keys(effortLabel) as Array<ReasoningEffort>;

/** Every effort any of `models` offers, weakest first: what one pick for all of them chooses from. */
export const effortsOf = (models: ReadonlyArray<ModelInfo>): ReadonlyArray<ReasoningEffort> =>
  effortOrder().filter((level) => models.some((model) => model.efforts.includes(level)));

/** The effort a model runs at: the chosen one when it has it, else its default or strongest. */
export const effortFor = (
  model: ModelInfo,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined =>
  effort !== undefined && model.efforts.includes(effort)
    ? effort
    : (model.defaultEffort ?? model.efforts.at(-1));

/** What an open thread's lead is switched to: another model of its harness, at an effort it has. */
export interface ModelSwitch {
  readonly model: string;
  /** Absent for a model its harness offers no effort setting for. */
  readonly effort?: ReasoningEffort;
  /** The effort router picks the effort each turn (true), or stops picking it (false). */
  readonly autoEffort?: boolean;
}

/**
 * The switch to `model`, carrying `effort` over where the model has it, and Auto when the lead is on
 * it. A harness that can't change effort keeps the thread's own, so asking for the model alone isn't
 * refused over it.
 */
export const switchTo = (
  model: ModelInfo,
  effort: ReasoningEffort | undefined,
  canSwitchEffort: boolean,
  auto = false,
): ModelSwitch => {
  const carried = canSwitchEffort ? effortFor(model, effort) : effort;
  return { model: model.id, ...(carried ? { effort: carried } : {}), ...(auto ? { autoEffort: true } : {}) };
};

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

/**
 * The access modes the starting models' harnesses can't run on this machine (`HarnessLimit`), with the
 * reason the first of them gives.
 */
export const accessLimit = (
  harnesses: ReadonlyArray<HarnessStatus>,
  starting: ReadonlyArray<Pick<ModelInfo, "provider">>,
): HarnessLimit | undefined => {
  const limits = harnesses.flatMap((status) =>
    status._tag === "HarnessInstalled" &&
    status.limit !== undefined &&
    starting.some((model) => model.provider === status.provider)
      ? [status.limit]
      : [],
  );
  const [first] = limits;
  return first && { blocks: [...new Set(limits.flatMap((limit) => limit.blocks))], reason: first.reason };
};

/** The access a thread starts with: the one picked, or Full access, the one that runs commands, when it's limited. */
export const allowedAccess = (access: AccessMode, limit: HarnessLimit | undefined): AccessMode =>
  limit?.blocks.includes(access) ? "fullAccess" : access;
