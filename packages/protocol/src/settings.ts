import { Effect, Schema, Struct } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { ProviderId } from "./ids.ts";

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
 * The user's settings the backend applies. Preferences that only change the window (theme, text
 * size, keys) stay in the UI.
 */
export const Settings = Schema.Struct({
  /** Load the MCP servers the user set up in each harness into sessions Cerium starts. */
  includeUserMcpServers: Schema.Boolean,
  /** Read as its default from a backend that predates it. */
  advisor: AdvisorSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultAdvisor))),
  /** Read as its default from a backend that predates it. */
  titles: TitleSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTitles))),
  /** Read as its default from a backend that predates it. */
  discord: DiscordSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultDiscord))),
});
export type Settings = typeof Settings.Type;

/** Some settings to change; the rest keep their values. */
export const SettingsPatch = Settings.mapFields(Struct.map(Schema.optionalKey));
export type SettingsPatch = typeof SettingsPatch.Type;

export const defaultSettings: Settings = {
  includeUserMcpServers: true,
  advisor: defaultAdvisor,
  titles: defaultTitles,
  discord: defaultDiscord,
};
