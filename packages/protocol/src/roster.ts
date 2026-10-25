import type { ProviderId } from "./ids.ts";
import type { ModelInfo } from "./models.ts";
import type { RosterModel, RosterSettings } from "./settings.ts";

// The roster as it applies to what the harnesses offer. Shared by the backend, which hands it to leads
// as their catalog, and the UI, which shows and edits it.

const key = (provider: ProviderId, model: string) => `${provider}/${model}`;

/**
 * Cerium's own line on what a lead should use a model for, where a harness's description says what
 * the model is rather than what to hand it. Ids are the ones each harness lists.
 */
const MODEL_USES: ReadonlyMap<string, string> = new Map([
  [key("claude", "fable"), "The hardest, longest-running problems"],
  [key("claude", "opus"), "Hard problems, design and review"],
  [key("claude", "sonnet"), "Everyday coding"],
  [key("claude", "haiku"), "Quick lookups and simple tasks"],
  [key("codex", "gpt-6-luna"), "Quick, inexpensive coding tasks"],
  [key("cursor", "composer-2.5"), "Fast edits and refactors"],
  [key("muse", "muse-spark-1.3"), "Everyday coding"],
  [key("opencode", "opencode/big-pickle"), "Free, for small low-stakes tasks"],
]);

/** The models each harness starts the roster with, best first, while the user hasn't changed its roster. */
const STARTER: ReadonlyArray<readonly [ProviderId, string]> = [
  ["claude", "opus"],
  ["claude", "sonnet"],
  ["claude", "haiku"],
  ["codex", "gpt-6-luna"],
  ["cursor", "composer-2.5"],
  // Not its default, the contributor tier, which lets Meta train on what it reads.
  ["muse", "muse-spark-1.3"],
  ["opencode", "opencode/big-pickle"],
];

/** What a lead is told to use `model` for: the user's words, else Cerium's, else the harness's. */
export const rosterUse = (model: ModelInfo, saved?: string): string => {
  const own = saved?.trim();
  if (own) return own;
  return MODEL_USES.get(key(model.provider, model.id)) ?? defaultUse(model);
};

/** The harness's own description, unless it only repeats the model's id. */
const defaultUse = (model: ModelInfo) => {
  const described = model.description?.trim();
  return described && described !== model.id ? described : model.label;
};

/**
 * The models one harness starts the roster with: Cerium's picks it offers, or else the model it
 * starts sessions on, or else the first it lists.
 */
export const starterRoster = (
  provider: ProviderId,
  offered: ReadonlyArray<ModelInfo>,
): ReadonlyArray<RosterModel> => {
  const own = offered.filter((model) => model.provider === provider);
  const picks = STARTER.flatMap(([pick, id]) =>
    pick === provider && own.some((model) => model.id === id) ? [{ provider, model: id }] : [],
  );
  if (picks.length > 0) return picks;
  const fallback = own.find((model) => model.isDefault === true) ?? own[0];
  return fallback === undefined ? [] : [{ provider, model: fallback.id }];
};

/** One model on the roster as it applies: what the harness says of it, and what a lead uses it for. */
export interface RosterMember {
  readonly model: ModelInfo;
  readonly use: string;
}

/**
 * The roster's models that the harnesses offer, harness by harness in the order they're offered: the
 * user's list for a harness they've edited, Cerium's starting picks for any other. A model the harness
 * no longer offers is left out.
 */
export const rosterMembers = (
  settings: RosterSettings,
  offered: ReadonlyArray<ModelInfo>,
): ReadonlyArray<RosterMember> => {
  const providers = [...new Set(offered.map((model) => model.provider))];
  return providers.flatMap((provider) => {
    const listed = settings.edited.includes(provider)
      ? settings.models.filter((entry) => entry.provider === provider)
      : starterRoster(provider, offered);
    const seen = new Set<string>();
    return listed.flatMap((entry) => {
      const model = offered.find((each) => each.provider === provider && each.id === entry.model);
      if (model === undefined || seen.has(model.id)) return [];
      seen.add(model.id);
      return [{ model, use: rosterUse(model, entry.use) }];
    });
  });
};

/**
 * The roster with one harness's list replaced by `models`: what the UI saves when the user adds,
 * removes or describes one of its models. The harness counts as edited from then on.
 */
export const withHarnessRoster = (
  settings: RosterSettings,
  provider: ProviderId,
  models: ReadonlyArray<RosterModel>,
): RosterSettings => ({
  models: [...settings.models.filter((entry) => entry.provider !== provider), ...models],
  edited: settings.edited.includes(provider) ? settings.edited : [...settings.edited, provider],
});

/** The roster with one harness back on Cerium's starting picks. */
export const withHarnessReset = (settings: RosterSettings, provider: ProviderId): RosterSettings => ({
  models: settings.models.filter((entry) => entry.provider !== provider),
  edited: settings.edited.filter((each) => each !== provider),
});
