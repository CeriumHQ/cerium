import { array } from "@cerium/acp";
import { isRecord, parseJsonc, readText, scratchFolder } from "@cerium/harness";
import type { AccessMode } from "@cerium/protocol";
import { Effect, FileSystem, Path } from "effect";
import { homedir } from "node:os";

import { PROVIDER, failure } from "./manifest.ts";

/** Where Devin keeps the user's configuration, which `--config` replaces for one run. */
export const userConfigPath = (path: Path.Path) =>
  process.platform === "win32"
    ? path.join(process.env["APPDATA"] || path.join(homedir(), "AppData", "Roaming"), "devin", "config.json")
    : path.join(process.env["XDG_CONFIG_HOME"] || path.join(homedir(), ".config"), "devin", "config.json");

const rules = (value: unknown) => array(value).filter((rule): rule is string => typeof rule === "string");

/**
 * The user's configuration as a Cerium session runs it. Their deny and ask rules and every other setting
 * carry over. Native subagents are off, so helpers go through Cerium's bus. Where Cerium's approval
 * flow decides (read-only and Ask), allow rules the user saved in Devin would skip it, so they are left
 * out, and Ask also routes workspace edits, which Devin's Code mode accepts, to approval. Without the
 * user's MCP servers, a saved grant for one of their tools is left out too, so the call asks and the
 * session refuses it. The legacy `mcpServers` key stays behind, so nothing migrates it out of the copy.
 */
export const sessionConfig = (user: unknown, access: AccessMode, includeUserMcpServers: boolean) => {
  const { mcpServers: _legacy, ...base } = isRecord(user) ? user : {};
  const permissions = isRecord(base["permissions"]) ? base["permissions"] : {};
  const ceriumAsks = access === "readOnly" || access === "ask";
  return {
    ...base,
    version: base["version"] ?? 1,
    subagents_enabled: false,
    permissions: {
      ...permissions,
      allow: ceriumAsks
        ? []
        : rules(permissions["allow"]).filter((rule) => includeUserMcpServers || !rule.startsWith("mcp__")),
      ask: [...rules(permissions["ask"]), ...(access === "ask" ? ["Write(**)"] : [])],
    },
  };
};

/** Writes the session's configuration in a folder of its own that goes when the scope closes. */
export const writeSessionConfig = Effect.fn("Devin.writeSessionConfig")(function* (
  access: AccessMode,
  includeUserMcpServers: boolean,
  userConfig?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = userConfig ?? userConfigPath(path);
  const text = yield* readText(source);
  const user = text.trim() === "" ? {} : parseJsonc(text);
  // Running without the user's deny rules would quietly widen what the agent may do.
  if (user === undefined) return yield* failure(`Cerium could not read your Devin settings in ${source}`);
  const directory = yield* scratchFolder(PROVIDER, "devin-config");
  const folder = yield* fs
    .makeTempDirectoryScoped({ directory, prefix: "session-" })
    .pipe(Effect.mapError((cause) => failure("Could not prepare Devin's session settings", cause)));
  const file = path.join(folder, "config.json");
  yield* fs
    .writeFileString(file, JSON.stringify(sessionConfig(user, access, includeUserMcpServers), null, 2))
    .pipe(Effect.mapError((cause) => failure("Could not write Devin's session settings", cause)));
  return file;
});
