import {
  HarnessFailure,
  HubConflict,
  isRecord,
  readText,
  rewriteFile,
  secretsOf,
  type HarnessHub,
  type HarnessUnavailable,
  type HubListing,
  type PortableServer,
} from "@cerium/harness";
import type {
  HubConnection,
  HubScope,
  HubServer,
  HubServerStatus,
  HubSkill,
  HubTargetScope,
} from "@cerium/protocol";
import { Effect, FileSystem, Path, type Context } from "effect";
import { ChildProcessSpawner } from "effect/process";

import type { ConfigLayer } from "./protocol/v2/ConfigLayer.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { McpServerStatus } from "./protocol/v2/McpServerStatus.ts";
import type { SkillMetadata } from "./protocol/v2/SkillMetadata.ts";
import { connect, type AppServer } from "./rpc.ts";
import { appendTomlTable, hasTable, setTomlKey, TomlEditError, type TomlValue } from "./toml.ts";

// Codex's MCP servers and skills, through its app-server: `config/read` gives each config layer (the
// user's `config.toml`, the project's `.codex/config.toml`, the system's), and Codex deep-merges them,
// so a project turns a user's server or its tools off with only `enabled = false` or `disabled_tools`
// in its own file. The app-server writes only the user's file; Cerium edits the project's itself,
// minimally, and has Codex read it back before keeping the change. Skills are switched with
// `skills/config/write`, which Codex applies to every project.

type Platform = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

const projectFile = (project: string) => `${project}/.codex/config.toml`;

const serversIn = (layer: ConfigLayer | undefined): Record<string, unknown> => {
  const config = layer?.config;
  return isRecord(config) && isRecord(config["mcp_servers"]) ? config["mcp_servers"] : {};
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A server as the merged config has it, scoped by the layer that defines it. */
export const codexServer = (
  name: string,
  merged: unknown,
  scope: HubScope,
  file: string | undefined,
): HubServer | undefined => {
  if (!isRecord(merged)) return undefined;
  const url = typeof merged["url"] === "string" ? merged["url"] : undefined;
  const command = typeof merged["command"] === "string" ? merged["command"] : undefined;
  if (url === undefined && command === undefined) return undefined;
  return {
    name,
    scope,
    transport: url !== undefined ? "http" : "stdio",
    ...(command !== undefined && url === undefined ? { command, args: strings(merged["args"]) } : {}),
    ...(url !== undefined ? { url } : {}),
    // `env_vars` and `env_http_headers` name variables Codex passes through, never values.
    env: [
      ...secretsOf(merged["env"]),
      ...strings(merged["env_vars"]).map((each) => ({ name: each, set: true })),
    ],
    headers: [
      ...secretsOf(merged["http_headers"]),
      ...Object.keys(isRecord(merged["env_http_headers"]) ? merged["env_http_headers"] : {}).map((each) => ({
        name: each,
        set: true,
      })),
      ...(typeof merged["bearer_token_env_var"] === "string" ? [{ name: "Authorization", set: true }] : []),
    ],
    enabled: merged["enabled"] !== false,
    disabledTools: strings(merged["disabled_tools"]),
    ...(file !== undefined ? { file } : {}),
  };
};

const defines = (value: unknown) =>
  isRecord(value) && (typeof value["command"] === "string" || typeof value["url"] === "string");

/** Codex's servers for a project, from `config/read`'s merged config and its layers. */
export const codexServers = (
  merged: unknown,
  layers: ReadonlyArray<ConfigLayer>,
): ReadonlyArray<HubServer> => {
  const servers = isRecord(merged) && isRecord(merged["mcp_servers"]) ? merged["mcp_servers"] : {};
  const project = layers.find((layer) => layer.name.type === "project" && !layer.disabledReason);
  const user = layers.find((layer) => layer.name.type === "user");
  // By name: Codex merges its layers into a map whose order changes from one read to the next.
  const named = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  return named.flatMap(([name, value]) => {
    const scope: HubScope = defines(serversIn(project)[name])
      ? "project"
      : defines(serversIn(user)[name])
        ? "user"
        : "bundled";
    const file =
      scope === "project" && project?.name.type === "project"
        ? `${project.name.dotCodexFolder}/config.toml`
        : scope === "user" && user?.name.type === "user"
          ? user.name.file
          : undefined;
    const server = codexServer(name, value, scope, file);
    return server === undefined ? [] : [server];
  });
};

const skillScope = (scope: SkillMetadata["scope"]): HubScope =>
  scope === "user" ? "user" : scope === "repo" ? "project" : "bundled";

/** The folder of a skill Codex lists by its `SKILL.md`. */
const folderOf = (file: string) => file.replace(/[\\/]SKILL\.md$/i, "");

export const codexSkills = (skills: ReadonlyArray<SkillMetadata>): ReadonlyArray<HubSkill> =>
  skills
    .filter((skill) => skill.pluginId === null)
    .map((skill) => ({
      name: skill.name,
      ...(skill.shortDescription || skill.description
        ? { description: skill.shortDescription ?? skill.description }
        : {}),
      scope: skillScope(skill.scope),
      path: folderOf(skill.path),
      enabled: skill.enabled,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const connectionOf = (status: McpServerStatus): HubConnection => {
  switch (status.runtimeStatus) {
    case "connected":
      return "connected";
    case "authenticationRequired":
      return "needsAuth";
    case "disabled":
      return "disabled";
    case "starting":
    case "notStarted":
      return "starting";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      if (status.toolsError !== null) return "failed";
      if (status.authStatus === "notLoggedIn") return "needsAuth";
      return "connected";
  }
};

/** A copied server in Codex's format, its secrets left blank. */
export const toCodexServer = (server: PortableServer): { readonly [key: string]: TomlValue } => {
  const blank = (names: ReadonlyArray<string>) => Object.fromEntries(names.map((name) => [name, ""]));
  return server.transport === "stdio"
    ? {
        command: server.command ?? "",
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env.length > 0 ? { env: blank(server.env) } : {}),
      }
    : {
        url: server.url ?? "",
        ...(server.headers.length > 0 ? { http_headers: blank(server.headers) } : {}),
      };
};

export const makeCodexHub = (
  ready: Effect.Effect<string, HarnessFailure | HarnessUnavailable>,
  platform: Context.Context<Platform>,
): HarnessHub => {
  /** Runs `use` against an app-server started in `project`, closed once it settles. */
  const withServer = <A, E>(project: string, use: (server: AppServer) => Effect.Effect<A, E, Platform>) =>
    ready.pipe(
      Effect.flatMap((executable) => Effect.scoped(Effect.flatMap(connect(executable, project), use))),
      Effect.provide(platform),
    );

  const configOf = (server: AppServer, project: string) =>
    server
      .request("config/read", { includeLayers: true, cwd: project })
      .pipe(Effect.mapError(failure("Could not read Codex's config")));

  const listing = (server: AppServer, project: string) =>
    Effect.gen(function* () {
      const config = yield* configOf(server, project);
      const layers = config.layers ?? [];
      const skills = yield* server.request("skills/list", { cwds: [project], forceReload: true }).pipe(
        Effect.map(({ data }) => data.flatMap((entry) => entry.skills)),
        Effect.mapError(failure("Could not list Codex's skills")),
      );
      const untrusted = layers.find(
        (layer) => layer.name.type === "project" && Boolean(layer.disabledReason),
      );
      const result: HubListing = {
        servers: codexServers(config.config, layers),
        skills: codexSkills(skills),
        ...(untrusted?.disabledReason ? { locked: untrusted.disabledReason } : {}),
      };
      return { result, layers };
    });

  /**
   * Edits the project's `.codex/config.toml`, then has Codex read it back: an edit Codex can't read, or
   * that didn't take, is undone.
   */
  const editProject = (
    project: string,
    edit: (text: string) => string,
    took: (servers: ReadonlyArray<HubServer>) => boolean,
  ) =>
    withServer(project, (server) =>
      Effect.gen(function* () {
        const { layers } = yield* listing(server, project);
        const untrusted = layers.find(
          (layer) => layer.name.type === "project" && Boolean(layer.disabledReason),
        );
        if (untrusted?.disabledReason) {
          return yield* new HarnessFailure({
            provider: "codex",
            message: untrusted.disabledReason,
            cause: undefined,
          });
        }
        const file = projectFile(project);
        const before = yield* readText(file);
        const after = yield* Effect.try({
          try: () => edit(before),
          catch: (cause) =>
            new HarnessFailure({
              provider: "codex",
              message:
                cause instanceof TomlEditError ? `${file}: ${cause.message}` : `Could not edit ${file}`,
              cause,
            }),
        });
        yield* rewriteFile(file, () => after).pipe(Effect.mapError(failure(`Could not write ${file}`)));
        const check = yield* configOf(server, project).pipe(
          Effect.map((config) => took(codexServers(config.config, config.layers ?? []))),
          Effect.orElseSucceed(() => false),
        );
        if (!check) {
          yield* rewriteFile(file, () => before).pipe(Effect.ignore);
          return yield* new HarnessFailure({
            provider: "codex",
            message: `Codex didn't take the change to ${file}, so it was undone`,
            cause: undefined,
          });
        }
      }),
    );

  const statusOf = (server: AppServer) =>
    Effect.gen(function* () {
      const all: Array<McpServerStatus> = [];
      let cursor: string | null = null;
      do {
        const page: ListMcpServerStatusResponse = yield* server
          .request("mcpServerStatus/list", { cursor, detail: "toolsAndAuthOnly" })
          .pipe(Effect.mapError(failure("Could not read Codex's MCP servers")));
        all.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return all.map((status): HubServerStatus => ({
        name: status.name,
        connection: connectionOf(status),
        ...(status.toolsError !== null ? { error: status.toolsError } : {}),
        ...(status.toolsError === null
          ? {
              tools: Object.values(status.tools).flatMap((tool) =>
                tool === undefined
                  ? []
                  : [{ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }],
              ),
            }
          : {}),
      }));
    });

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    withServer(project, (app) =>
      Effect.gen(function* () {
        if (server.transport === "sse") {
          return yield* new HubConflict({
            message: "Codex connects to streamable HTTP servers, not SSE ones.",
          });
        }
        const { result } = yield* listing(app, project);
        if (result.servers.some((each) => each.name === server.name)) {
          return yield* new HubConflict({ message: `Codex already has a server named ${server.name}.` });
        }
        const entries = toCodexServer(server);
        if (scope === "user") {
          const written = yield* app
            .request("config/value/write", {
              keyPath: `mcp_servers.${server.name}`,
              value: entries as never,
              mergeStrategy: "upsert",
            })
            .pipe(Effect.mapError(failure("Could not write Codex's config")));
          return written.filePath;
        }
        const file = projectFile(project);
        const text = yield* readText(file);
        if (hasTable(text, ["mcp_servers", server.name])) {
          return yield* new HubConflict({ message: `${file} already has a server named ${server.name}.` });
        }
        yield* rewriteFile(file, (current) =>
          appendTomlTable(current, ["mcp_servers", server.name], entries),
        ).pipe(Effect.mapError(failure(`Could not write ${file}`)));
        return file;
      }),
    );

  return {
    support: { servers: "project", tools: "project", skills: "everywhere", status: true },
    read: (project) =>
      withServer(project, (server) => Effect.map(listing(server, project), ({ result }) => result)),
    status: (project) => withServer(project, statusOf),
    setServer: (project, server, enabled) =>
      editProject(
        project,
        (text) =>
          // A project's own server is switched where it's defined; a user's, by the project's override.
          setTomlKey(
            text,
            ["mcp_servers", server.name],
            "enabled",
            enabled && server.scope !== "project" ? undefined : enabled,
          ),
        (servers) => servers.find((each) => each.name === server.name)?.enabled === enabled,
      ).pipe(
        // Removing the override leaves the user's own `enabled = false`, if it has one: say so plainly.
        Effect.catchIf(
          (error) =>
            error._tag === "HarnessFailure" && enabled && error.message.startsWith("Codex didn't take"),
          () =>
            editProject(
              project,
              (text) => setTomlKey(text, ["mcp_servers", server.name], "enabled", true),
              (servers) => servers.find((each) => each.name === server.name)?.enabled === true,
            ),
        ),
      ),
    setTool: (project, server, tool, enabled) => {
      const next = enabled
        ? server.disabledTools.filter((each) => each !== tool)
        : [...new Set([...server.disabledTools, tool])];
      return editProject(
        project,
        (text) =>
          setTomlKey(
            text,
            ["mcp_servers", server.name],
            "disabled_tools",
            next.length > 0 ? next : undefined,
          ),
        (servers) =>
          (servers.find((each) => each.name === server.name)?.disabledTools.includes(tool) ?? false) !==
          enabled,
      );
    },
    setSkill: (project, skill, enabled) =>
      withServer(project, (server) =>
        server
          .request("skills/config/write", { path: `${skill.path}/SKILL.md`, enabled })
          .pipe(Effect.asVoid, Effect.mapError(failure("Could not switch the Codex skill"))),
      ),
    addServer,
    skillsFolder: (project, scope) =>
      scope === "project"
        ? Effect.succeed(`${project}/.agents/skills`)
        : withServer(project, (server) => Effect.succeed(`${server.codexHome}/skills`)),
  };
};
