import { effortOf, type InitializeResponse } from "@cerium/adapter-acp";
import type { ModelInfo, ReasoningEffort } from "@cerium/protocol";

// Grok Build lists its models before any session: `initialize`'s `_meta.modelState` (seen live in 1.0.70)
// names each model with the efforts it takes and its default one. A session's `model` and
// `reasoning_effort` config options then switch them.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ORDER: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The models `initialize` offers, the one Grok starts on marked as its default. */
export const grokModels = (initialized: InitializeResponse): ReadonlyArray<ModelInfo> => {
  const state = isRecord(initialized._meta) ? initialized._meta["modelState"] : undefined;
  if (!isRecord(state) || !Array.isArray(state["availableModels"])) return [];
  const current = state["currentModelId"];
  return state["availableModels"].flatMap((entry): ReadonlyArray<ModelInfo> => {
    if (!isRecord(entry) || typeof entry["modelId"] !== "string" || entry["modelId"] === "") return [];
    const meta = isRecord(entry["_meta"]) ? entry["_meta"] : {};
    const choices = Array.isArray(meta["reasoningEfforts"]) ? meta["reasoningEfforts"].filter(isRecord) : [];
    const levels = new Map<ReasoningEffort, boolean>();
    for (const choice of choices) {
      const value =
        typeof choice["value"] === "string"
          ? choice["value"]
          : typeof choice["id"] === "string"
            ? choice["id"]
            : "";
      const effort = effortOf({ value, name: typeof choice["label"] === "string" ? choice["label"] : value });
      if (effort !== undefined) levels.set(effort, levels.get(effort) === true || choice["default"] === true);
    }
    const efforts = ORDER.filter((effort) => levels.has(effort));
    const named =
      typeof meta["reasoningEffort"] === "string"
        ? effortOf({ value: meta["reasoningEffort"], name: "" })
        : undefined;
    const defaultEffort =
      efforts.find((effort) => levels.get(effort) === true) ??
      (named && efforts.includes(named) ? named : undefined);
    const id = entry["modelId"];
    return [
      {
        provider: "grok",
        id,
        label: typeof entry["name"] === "string" && entry["name"].trim() !== "" ? entry["name"] : id,
        ...(typeof entry["description"] === "string" && entry["description"] !== ""
          ? { description: entry["description"] }
          : {}),
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(id === current ? { isDefault: true } : {}),
      },
    ];
  });
};
