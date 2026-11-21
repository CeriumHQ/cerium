import {
  editJsonc,
  fromMcpJson,
  HarnessFailure,
  HubConflict,
  isRecord,
  parseJsonc,
  readText,
  rewriteFile,
  toMcpJson,
  type HarnessHub,
  type PortableServer,
} from "@cerium/harness";
import type { HubScope, HubServer, HubTargetScope } from "@cerium/protocol";
import { Effect, FileSystem, Path, Semaphore, type Context } from "effect";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readCursorSkills } from "./skills.ts";

// Cursor's MCP servers and skills, in its own files: `~/.cursor/mcp.json` and the project's
// `.cursor/mcp.json` (the `mcpServers` format Claude Code shares), and the skill folders the SDK's
// runtime scans (skills.ts). The local SDK loads the project's disabled server names from
// mcp-disabled.json under its project data folder. It has no live status, tool or skill switch API.

type Platform = FileSystem.FileSystem | Path.Path;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "cursor", message, cause });

const projectRoot = Effect.fn("CursorHub.projectRoot")(function* (project: string) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = resolve(project);
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (yield* fs.exists(join(directory, ".git")).pipe(Effect.orElseSucceed(() => false))) return directory;
    if (directory === dirname(directory)) return cwd;
  }
});

/** The pinned local runtime uses its workspace-path slug for folders under Cursor's data directory. */
const disabledConfig = (project: string, data: string) =>
  join(data, "projects", project.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""), "mcp-disabled.json");

const disabledNames = (text: string): ReadonlyArray<string> | undefined => {
  if (text.trim() === "") return [];
  const value = parseJsonc(text);
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : undefined;
};

/** The servers of a Cursor `mcp.json`'s text. */
export const cursorServers = (text: string, scope: HubScope, file: string): ReadonlyArray<HubServer> => {
  const parsed = parseJsonc(text);
  const servers = isRecord(parsed) && isRecord(parsed["mcpServers"]) ? parsed["mcpServers"] : {};
  return Object.entries(servers).flatMap(([name, value]) => {
    const server = fromMcpJson(name, value, scope, file);
    return server === undefined ? [] : [server];
  });
};

/** A copied server as Cursor writes one: `command` or `url`, with no `type`. */
export const toCursorServer = (server: PortableServer): Record<string, unknown> => {
  const { type: _type, ...rest } = toMcpJson(server);
  return rest;
};

export const makeCursorHub = (
  platform: Context.Context<Platform>,
  home: string = homedir(),
  data: string = process.env["CURSOR_DATA_DIR"]?.trim() || join(home, ".cursor"),
): HarnessHub => {
  const userFolder = join(home, ".cursor");
  const folderFor = (project: string, scope: HubTargetScope) =>
    scope === "user"
      ? Effect.succeed(userFolder)
      : projectRoot(project).pipe(Effect.map((root) => join(root, ".cursor")));
  const writes = Semaphore.makeUnsafe(1);

  const read = (project: string) =>
    Effect.gen(function* () {
      const root = yield* projectRoot(project);
      const disabled = new Set(disabledNames(yield* readText(disabledConfig(root, data))));
      const files = [
        [join(userFolder, "mcp.json"), "user"],
        [join(root, ".cursor", "mcp.json"), "project"],
      ] as const;
      const byName = new Map<string, HubServer>();
      for (const [file, scope] of files) {
        for (const server of cursorServers(yield* readText(file), scope, file))
          byName.set(server.name, { ...server, enabled: !disabled.has(server.name) });
      }
      return { servers: [...byName.values()], skills: yield* readCursorSkills(project, home) };
    });

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    Effect.gen(function* () {
      const folder = yield* folderFor(project, scope);
      const file = join(folder, "mcp.json");
      const text = yield* readText(file);
      const parsed = parseJsonc(text);
      if (text.trim() !== "" && !isRecord(parsed)) {
        return yield* new HarnessFailure({
          provider: "cursor",
          message: `${file} isn't valid JSON`,
          cause: undefined,
        });
      }
      if (cursorServers(text, scope, file).some((each) => each.name === server.name)) {
        return yield* new HubConflict({ message: `${file} already has a server named ${server.name}.` });
      }
      yield* rewriteFile(file, (current) =>
        editJsonc(current, ["mcpServers", server.name], toCursorServer(server)),
      ).pipe(Effect.mapError(failure(`Could not write ${file}`)));
      return file;
    });

  return {
    support: { servers: "project", tools: "none", skills: "none", status: false },
    read: (project) => Effect.provide(read(project), platform),
    setServer: (project, server, enabled) =>
      Effect.gen(function* () {
        const file = disabledConfig(yield* projectRoot(project), data);
        const before = yield* readText(file);
        const names = disabledNames(before);
        if (names === undefined)
          return yield* failure(`Invalid disabled server configuration in ${file}`)(undefined);
        const disabled = new Set(names);
        if (disabled.has(server.name) === !enabled) return;
        if (enabled) disabled.delete(server.name);
        else disabled.add(server.name);
        yield* rewriteFile(file, () => JSON.stringify([...disabled], null, 2) + "\n").pipe(
          Effect.mapError(failure(`Could not write ${file}`)),
        );
      }).pipe((edit) => writes.withPermit(edit), Effect.provide(platform)),
    addServer: (project, scope, server) =>
      Effect.provide(writes.withPermit(addServer(project, scope, server)), platform),
    skillsFolder: (project, scope) =>
      Effect.provide(
        folderFor(project, scope).pipe(Effect.map((folder) => join(folder, "skills"))),
        platform,
      ),
  };
};
