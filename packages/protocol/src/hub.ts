import { Schema } from "effect";

import { ProviderId } from "./ids.ts";

// The MCP and skills hub: each harness's MCP servers and skills as the harness itself configures them,
// read from its own files and protocol. A secret never leaves the harness's files: a server's
// environment variables and headers travel as their names and whether each has a value, never the value.

/**
 * Where a server or skill is configured: for every project (`user`), in the project's own files, shared
 * with whoever clones it (`project`), for the project on this machine only (`local`, Claude Code's
 * private project scope), or by the harness or a plugin (`bundled`), which Cerium doesn't edit.
 */
export const HubScope = Schema.Literals(["user", "project", "local", "bundled"]);
export type HubScope = typeof HubScope.Type;

/** The scopes a server or skill can be copied into. */
export const HubTargetScope = Schema.Literals(["user", "project"]);
export type HubTargetScope = typeof HubTargetScope.Type;

/**
 * How a harness turns something off: for one project, only for every project at once, or not at all
 * (the user removes it from the harness's config instead).
 */
export const HubSwitch = Schema.Literals(["project", "everywhere", "none"]);
export type HubSwitch = typeof HubSwitch.Type;

/** What a harness can turn off natively, which the hub offers and nothing more. */
export const HubSupport = Schema.Struct({
  servers: HubSwitch,
  /** A server's single tools. */
  tools: HubSwitch,
  skills: HubSwitch,
  /** The harness reports which servers are connected, and their tools. */
  status: Schema.Boolean,
});
export type HubSupport = typeof HubSupport.Type;

/** An environment variable or header of a server: its name, and whether the config gives it a value. */
export const HubSecret = Schema.Struct({ name: Schema.String, set: Schema.Boolean });
export type HubSecret = typeof HubSecret.Type;

export const HubTransport = Schema.Literals(["stdio", "http", "sse"]);
export type HubTransport = typeof HubTransport.Type;

/** An MCP server as a harness configures it, without its secrets. */
export const HubServer = Schema.Struct({
  name: Schema.NonEmptyString,
  scope: HubScope,
  transport: HubTransport,
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  env: Schema.Array(HubSecret),
  headers: Schema.Array(HubSecret),
  /** On in the project the hub shows. */
  enabled: Schema.Boolean,
  /** Tools turned off in that project, by name. */
  disabledTools: Schema.Array(Schema.String),
  /** The file it's configured in, when the harness keeps it in one. */
  file: Schema.optionalKey(Schema.String),
});
export type HubServer = typeof HubServer.Type;

/** A skill a harness offers in the project, from its own folder. */
export const HubSkill = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  scope: HubScope,
  /** The skill's folder, which holds its `SKILL.md`. */
  path: Schema.String,
  enabled: Schema.Boolean,
});
export type HubSkill = typeof HubSkill.Type;

/** One harness's servers and skills for a project. */
export const HubHarness = Schema.Struct({
  provider: ProviderId,
  support: HubSupport,
  servers: Schema.Array(HubServer),
  skills: Schema.Array(HubSkill),
  /** Why the harness couldn't be read (not installed, an unreadable file), written for the user. */
  unavailable: Schema.optionalKey(Schema.String),
  /** Something the user should know about this project's config, such as Codex not trusting it yet. */
  notice: Schema.optionalKey(Schema.String),
});
export type HubHarness = typeof HubHarness.Type;

/** A server's connection as its harness reports it right now. */
export const HubConnection = Schema.Literals(["connected", "starting", "failed", "needsAuth", "disabled"]);
export type HubConnection = typeof HubConnection.Type;

export const HubTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export type HubTool = typeof HubTool.Type;

/** A server's live state: its connection, and the tools it offers once connected. */
export const HubServerStatus = Schema.Struct({
  name: Schema.String,
  connection: HubConnection,
  /** Why it failed, in the harness's words. */
  error: Schema.optionalKey(Schema.String),
  /** Absent when the harness couldn't list them, such as before it connects. */
  tools: Schema.optionalKey(Schema.Array(HubTool)),
});
export type HubServerStatus = typeof HubServerStatus.Type;

/** Where a copy went, or why it didn't. */
export const HubCopyOutcome = Schema.Struct({
  provider: ProviderId,
  /** The file or folder written. */
  wrote: Schema.optionalKey(Schema.String),
  /** Environment variables and headers left empty for the user to fill in. */
  fill: Schema.Array(Schema.String),
  /** Why nothing was written, such as a server of that name already being there. */
  skipped: Schema.optionalKey(Schema.String),
});
export type HubCopyOutcome = typeof HubCopyOutcome.Type;
