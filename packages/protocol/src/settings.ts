import { Schema, Struct } from "effect";

/**
 * The user's settings the backend applies. Preferences that only change the window (theme, text
 * size, keys) stay in the UI.
 */
export const Settings = Schema.Struct({
  /** Load the MCP servers the user set up in each harness into sessions Cerium starts (§2.2). */
  includeUserMcpServers: Schema.Boolean,
});
export type Settings = typeof Settings.Type;

/** Some settings to change; the rest keep their values. */
export const SettingsPatch = Settings.mapFields(Struct.map(Schema.optionalKey));
export type SettingsPatch = typeof SettingsPatch.Type;

export const defaultSettings: Settings = { includeUserMcpServers: true };
