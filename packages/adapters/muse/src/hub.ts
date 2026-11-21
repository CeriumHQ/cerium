import {
  editJsonc,
  editJsoncPruned,
  fromMcpJson,
  HarnessFailure,
  HubConflict,
  isRecord,
  parseJsonc,
  readText,
  rewriteFile,
  toMcpJson,
  type HarnessHub,
  type HarnessUnavailable,
  type PortableServer,
} from "@cerium/harness";
import type { HubScope, HubServer, HubSkill, HubTargetScope } from "@cerium/protocol";
import { Effect, FileSystem, Path, Semaphore, type Context } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { dirname, join, resolve } from "node:path";

import { museConfigFolder, readMuseSkills, runMuseSkills, toHubSkill } from "./skills.ts";

type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });
const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const entries = (config: unknown) => {
  if (!isRecord(config)) return {};
  const servers = config["mcpServers"];
  return isRecord(servers) ? servers : {};
};

/** Muse stores native MCP configs in user settings and trusted `.mcp.json` files from repo root to cwd. */
export const museServers = (text: string, scope: HubScope, file: string): ReadonlyArray<HubServer> =>
  Object.entries(entries(parseJsonc(text))).flatMap(([name, config]) => {
    if (!isRecord(config)) return [];
    const native = config["type"];
    const server = fromMcpJson(
      name,
      native === "streamable-http" ? { ...config, type: "http" } : config,
      scope,
      file,
    );
    if (server === undefined) return [];
    return [
      {
        ...server,
        enabled: config["enabled"] !== false,
        disabledTools: strings(config["disabled_tools"]),
      },
    ];
  });

const directories = Effect.fn("MuseHub.directories")(function* (project: string) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = resolve(project);
  const found = [cwd];
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (yield* fs.exists(join(directory, ".git")).pipe(Effect.orElseSucceed(() => false)))
      return found.reverse();
    if (directory === dirname(directory)) return [cwd];
    found.push(dirname(directory));
  }
});

export const makeMuseHub = (
  executable: Effect.Effect<string, HarnessUnavailable | HarnessFailure>,
  platform: Context.Context<Platform>,
  configFolder = museConfigFolder,
): HarnessHub => {
  const writes = Semaphore.makeUnsafe(1);
  const provided = <A, E>(effect: Effect.Effect<A, E, Platform>) => Effect.provide(effect, platform);
  const settings = () => join(configFolder(), "settings.json");
  const read = (project: string) =>
    Effect.gen(function* () {
      const byName = new Map<string, HubServer>();
      for (const server of museServers(yield* readText(settings()), "user", settings()))
        byName.set(server.name, server);
      for (const directory of yield* directories(project)) {
        const file = join(directory, ".mcp.json");
        for (const server of museServers(yield* readText(file), "project", file))
          byName.set(server.name, server);
      }
      const skills = yield* readMuseSkills(yield* executable, project);
      return { servers: [...byName.values()], skills: skills.map((skill) => toHubSkill(project, skill)) };
    });

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    Effect.gen(function* () {
      if (server.transport === "sse")
        return yield* failure("Muse Code supports stdio and Streamable HTTP MCP servers")(undefined);
      const file =
        scope === "user" ? settings() : join((yield* directories(project))[0] ?? project, ".mcp.json");
      const text = yield* readText(file);
      const config = parseJsonc(text);
      if (
        text.trim() !== "" &&
        (!isRecord(config) || (config["mcpServers"] !== undefined && !isRecord(config["mcpServers"])))
      ) {
        return yield* failure(`Invalid MCP configuration in ${file}`)(undefined);
      }
      if (Object.hasOwn(entries(config), server.name)) {
        return yield* new HubConflict({ message: `${file} already has a server named ${server.name}.` });
      }
      yield* rewriteFile(file, (current) =>
        editJsonc(current, ["mcpServers", server.name], {
          ...toMcpJson(server),
          type: server.transport === "http" ? "streamable-http" : "stdio",
        }),
      ).pipe(Effect.mapError(failure(`Could not write ${file}`)));
      return file;
    });

  const editServer = (server: HubServer, edit: (text: string, config: Record<string, unknown>) => string) =>
    Effect.gen(function* () {
      const file = server.file;
      if (file === undefined)
        return yield* failure("Muse Code did not report this server's config file")(undefined);
      const before = yield* readText(file);
      const config = entries(parseJsonc(before))[server.name];
      if (!isRecord(config)) return yield* failure(`Could not find ${server.name} in ${file}`)(undefined);
      yield* rewriteFile(file, () => edit(before, config)).pipe(
        Effect.mapError(failure(`Could not write ${file}`)),
      );
    });

  const setSkill = (project: string, skill: HubSkill, enabled: boolean) =>
    Effect.gen(function* () {
      const binary = yield* executable;
      const discovered = (yield* readMuseSkills(binary, project)).find((row) => {
        const shown = toHubSkill(project, row);
        return shown.name === skill.name && shown.scope === skill.scope && shown.path === skill.path;
      });
      if (discovered === undefined) return yield* failure("Muse Code no longer lists this skill")(undefined);
      yield* runMuseSkills(binary, project, [
        enabled ? "enable" : "disable",
        discovered.scope === "project" || discovered.scope === "user"
          ? join(skill.path, "SKILL.md")
          : discovered.id,
        "--scope",
        discovered.scope === "bundled" ? "built-in" : discovered.scope,
      ]);
    });

  return {
    // User server/tool switches edit user settings. The skill CLI stores project overrides per workspace.
    // MSP has no live MCP status/tool catalog RPC.
    support: { servers: "everywhere", tools: "everywhere", skills: "project", status: false },
    read: (project) => provided(read(project)),
    addServer: (project, scope, server) => provided(writes.withPermit(addServer(project, scope, server))),
    setServer: (_project, server, enabled) =>
      provided(
        writes.withPermit(
          editServer(server, (text) =>
            editJsonc(text, ["mcpServers", server.name, "enabled"], enabled ? undefined : false),
          ),
        ),
      ),
    setTool: (_project, server, tool, enabled) =>
      provided(
        writes.withPermit(
          editServer(server, (text, config) => {
            const disabled = new Set(strings(config["disabled_tools"]));
            if (enabled) disabled.delete(tool);
            else disabled.add(tool);
            return editJsoncPruned(text, ["mcpServers", server.name, "disabled_tools"], [...disabled]);
          }),
        ),
      ),
    setSkill: (project, skill, enabled) => provided(writes.withPermit(setSkill(project, skill, enabled))),
    skillsFolder: (project, scope) =>
      scope === "user"
        ? Effect.sync(() => join(configFolder(), "skills"))
        : Effect.succeed(join(project, ".agents", "skills")),
  };
};
