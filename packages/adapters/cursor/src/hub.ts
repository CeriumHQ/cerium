import {
  editJsonc,
  fromMcpJson,
  HarnessFailure,
  HubConflict,
  isRecord,
  parseJsonc,
  readSkillFolders,
  readText,
  rewriteFile,
  toMcpJson,
  type HarnessHub,
  type PortableServer,
} from "@cerium/harness";
import type { HubScope, HubServer, HubTargetScope } from "@cerium/protocol";
import { Effect, FileSystem, Path, type Context } from "effect";
import { homedir } from "node:os";

// Cursor's MCP servers and skills, in its own files: `~/.cursor/mcp.json` and the project's
// `.cursor/mcp.json` (the `mcpServers` format Claude Code shares), and the `skills` folders beside
// them. Cursor turns servers and their tools off in its own app settings, not in a file per project,
// and has no switch for a skill, so the hub offers none for it.

type Platform = FileSystem.FileSystem | Path.Path;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "cursor", message, cause });

const userFolder = () => `${homedir()}/.cursor`;

const folderFor = (project: string, scope: HubTargetScope) =>
  scope === "user" ? userFolder() : `${project}/.cursor`;

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

export const makeCursorHub = (platform: Context.Context<Platform>): HarnessHub => {
  const read = (project: string) =>
    Effect.gen(function* () {
      const files = [
        [`${userFolder()}/mcp.json`, "user"],
        [`${project}/.cursor/mcp.json`, "project"],
      ] as const;
      const byName = new Map<string, HubServer>();
      for (const [file, scope] of files) {
        for (const server of cursorServers(yield* readText(file), scope, file))
          byName.set(server.name, server);
      }
      const skills = [
        ...(yield* readSkillFolders(`${userFolder()}/skills`, "user")),
        ...(yield* readSkillFolders(`${project}/.cursor/skills`, "project")),
      ];
      return { servers: [...byName.values()], skills };
    });

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    Effect.gen(function* () {
      const file = `${folderFor(project, scope)}/mcp.json`;
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
    support: { servers: "none", tools: "none", skills: "none", status: false },
    read: (project) => Effect.provide(read(project), platform),
    addServer: (project, scope, server) => Effect.provide(addServer(project, scope, server), platform),
    skillsFolder: (project, scope) => Effect.succeed(`${folderFor(project, scope)}/skills`),
  };
};
