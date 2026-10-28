import { Effect, Schema, Struct } from "effect";

import { ReasoningEffort, StoredSpeed } from "./capabilities.ts";
import { LenientArray, withFallback } from "./compat.ts";
import { ProviderId } from "./ids.ts";
import { PromptsSettings } from "./savedPrompts.ts";

/**
 * The model agents ask through the bus's `ask_advisor` when they are stuck. It
 * answers and never works: Cerium runs it read only. The pick is kept while it is off.
 */
export const AdvisorSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Absent until the user picks one; an enabled advisor without one answers nobody. */
  model: Schema.optionalKey(
    Schema.Struct({
      provider: ProviderId,
      model: Schema.NonEmptyString,
      effort: Schema.optionalKey(ReasoningEffort),
    }),
  ),
});
export type AdvisorSettings = typeof AdvisorSettings.Type;

const defaultAdvisor: AdvisorSettings = { enabled: false };

/** A model as harness and id, without the effort a completion never takes. */
export const ModelChoice = Schema.Struct({ provider: ProviderId, model: Schema.NonEmptyString });
export type ModelChoice = typeof ModelChoice.Type;

/**
 * The models that name threads when the user hasn't picked one, best first: the first one a
 * logged-in harness offers is used. One per provider, so every user has one.
 */
export const TITLE_MODELS: ReadonlyArray<ModelChoice> = [
  { provider: "claude", model: "haiku" },
  { provider: "codex", model: "gpt-6-luna" },
  { provider: "cursor", model: "composer-2.5" },
  // Free on OpenCode Zen, so it names threads even without a provider signed in.
  { provider: "opencode", model: "opencode/big-pickle" },
  { provider: "muse", model: "muse-spark-1.3-contributor" },
];

/** How Cerium names a new thread from its first message. */
export const TitleSettings = Schema.Struct({
  /** Off, a thread keeps the first line of its first message as its title. */
  enabled: Schema.Boolean,
  /** Absent: the first of `TITLE_MODELS` the user's harnesses offer. */
  model: Schema.optionalKey(ModelChoice),
});
export type TitleSettings = typeof TitleSettings.Type;

const defaultTitles: TitleSettings = { enabled: true };

/**
 * Discord Rich Presence: the user's Discord profile says they're using Cerium, how many agents are
 * working and in which harnesses. Thread titles never leave the machine; folder names only when asked.
 */
export const DiscordSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Name the folder the working agents are in, such as "in cerium". */
  showProject: Schema.Boolean,
});
export type DiscordSettings = typeof DiscordSettings.Type;

const defaultDiscord: DiscordSettings = { enabled: false, showProject: false };

/**
 * The experimental effort router: on agents set to Auto, a decision model (Jev, through the user's
 * own OpenRouter key) picks each turn's reasoning effort. It stays off without a saved key.
 */
export const EffortRouterSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /**
   * Who picks the effort of a child an Auto lead spawns without one: `router`, the child is Auto too;
   * `lead`, it runs at its lead's current level.
   */
  children: withFallback(Schema.Literals(["router", "lead"]), "router"),
  /**
   * The level a turn runs at when the router can't decide: no answer in time, none it could use, or
   * one too unsure. A model without it takes its next level up, or its highest. Read as `high` from
   * settings saved before it.
   */
  fallback: withFallback(ReasoningEffort, "high").pipe(Schema.withDecodingDefaultKey(Effect.succeed("high"))),
});
export type EffortRouterSettings = typeof EffortRouterSettings.Type;

const defaultEffortRouter: EffortRouterSettings = { enabled: false, children: "router", fallback: "high" };

/** A model on the roster, with what a lead should use it for and the speed it runs at. */
export const RosterModel = Schema.Struct({
  provider: ProviderId,
  model: Schema.NonEmptyString,
  /** In the user's words; absent, Cerium's line for the model or its harness's description (`rosterUse`). */
  use: Schema.optionalKey(Schema.String),
  /**
   * The speed a lead starts it at, where the model offers a choice (`ModelInfo.speeds`); absent, the
   * harness's own default.
   */
  speed: Schema.optionalKey(StoredSpeed),
});
export type RosterModel = typeof RosterModel.Type;

/**
 * The roster: the models a lead starts without asking the user, and what it uses each for. A harness
 * the user has changed the roster of is in `edited` and offers the `models` listed for it, in their
 * order, which is the order of priority leads pick by; any other offers Cerium's starting picks
 * (`starterRoster`), so a harness signed in later joins with them.
 */
export const RosterSettings = Schema.Struct({
  models: LenientArray(RosterModel),
  edited: LenientArray(ProviderId),
});
export type RosterSettings = typeof RosterSettings.Type;

const defaultRoster: RosterSettings = { models: [], edited: [] };

const defaultPrompts: PromptsSettings = { prompts: [] };

/** The days a thread can go quiet before it's slimmed, the user's choices; 0 never slims. */
export const SLIM_AFTER_DAYS = [0, 1, 3, 7, 14, 30] as const;

/**
 * How many days nothing has happened in a thread before its screenshots and the harnesses' payloads
 * kept beside its events are removed (`Store.slimThreads`); its text stays.
 */
export const SlimThreadsAfter = Schema.Literals(SLIM_AFTER_DAYS);
export type SlimThreadsAfter = typeof SlimThreadsAfter.Type;

const defaultSlimThreadsAfter: SlimThreadsAfter = 7;

/** Each setting's shape, without the defaults `Settings` reads a missing one as. */
const SettingsFields = Schema.Struct({
  /** Load the MCP servers the user set up in each harness into sessions Cerium starts. */
  includeUserMcpServers: Schema.Boolean,
  advisor: AdvisorSettings,
  titles: TitleSettings,
  discord: DiscordSettings,
  effortRouter: EffortRouterSettings,
  roster: RosterSettings,
  prompts: PromptsSettings,
  slimThreadsAfter: SlimThreadsAfter,
});

/**
 * The user's settings the backend applies. Preferences that only change the window (theme, text
 * size, keys) stay in the UI.
 */
export const Settings = Schema.Struct({
  ...SettingsFields.fields,
  /** Read as its default from a backend that predates it. */
  advisor: AdvisorSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultAdvisor))),
  /** Read as its default from a backend that predates it. */
  titles: TitleSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTitles))),
  /** Read as its default from a backend that predates it. */
  discord: DiscordSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultDiscord))),
  /** Read as its default from a backend that predates it. */
  effortRouter: EffortRouterSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEffortRouter))),
  /** Read as its default from a backend that predates it, which has none (`RPC_VERSION` 27). */
  roster: RosterSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultRoster))),
  /** Read as its default from a backend that predates it, which has none (`RPC_VERSION` 37). */
  prompts: PromptsSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPrompts))),
  /** Read as its default from a backend that predates it, which has none (`RPC_VERSION` 38). */
  slimThreadsAfter: SlimThreadsAfter.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultSlimThreadsAfter)),
  ),
});
export type Settings = typeof Settings.Type;

/**
 * Some settings to change; the rest keep their values. Built without `Settings`' decoding defaults,
 * which would fill every missing key in and so reset the settings the patch leaves out.
 */
export const SettingsPatch = SettingsFields.mapFields(Struct.map(Schema.optionalKey));
export type SettingsPatch = typeof SettingsPatch.Type;

export const defaultSettings: Settings = {
  includeUserMcpServers: true,
  advisor: defaultAdvisor,
  titles: defaultTitles,
  discord: defaultDiscord,
  effortRouter: defaultEffortRouter,
  roster: defaultRoster,
  prompts: defaultPrompts,
  slimThreadsAfter: defaultSlimThreadsAfter,
};
