import { makeJsonMcpHub, projectFolders, readAcpSkillFolders } from "@cerium/acp";
import { toMcpJson } from "@cerium/harness";
import { Effect, Path } from "effect";
import { homedir } from "node:os";

import { userConfigPath } from "./config.ts";
import { devinHarness } from "./manifest.ts";

export const makeDevinHub = Effect.fn("Devin.hub")(function* (userConfig?: string, home = homedir()) {
  const path = yield* Path.Path;
  const config = userConfig ?? userConfigPath(path);
  const user = path.dirname(config);
  const projectFolder = (project: string) => path.join(project, ".devin");
  const root = (project: string) =>
    projectFolders(project).pipe(Effect.map((folders) => folders.at(-1) ?? project));
  const scopeFolder = (project: string, scope: "project" | "user") =>
    scope === "user" ? Effect.succeed(user) : root(project).pipe(Effect.map(projectFolder));
  return yield* makeJsonMcpHub({
    harness: devinHarness,
    files: (project) =>
      root(project).pipe(
        Effect.map(
          (folder) =>
            [
              [path.join(projectFolder(folder), "mcp_config.local.json"), "local"],
              [path.join(projectFolder(folder), "config.local.json"), "local"],
              [path.join(projectFolder(folder), "mcp_config.json"), "project"],
              [path.join(projectFolder(folder), "config.json"), "project"],
              [path.join(user, "mcp_config.json"), "user"],
              [config, "user"],
            ] as const,
        ),
      ),
    copyFile: (project, scope) =>
      scopeFolder(project, scope).pipe(Effect.map((folder) => path.join(folder, "mcp_config.json"))),
    skills: (project) =>
      root(project).pipe(
        Effect.flatMap((folder) =>
          readAcpSkillFolders([
            [path.join(projectFolder(folder), "skills"), "project"],
            [path.join(folder, ".cognition", "skills"), "project"],
            [path.join(folder, ".agents", "skills"), "project"],
            [path.join(user, "skills"), "user"],
            [path.join(user, "..", "cognition", "skills"), "user"],
            [path.join(home, ".agents", "skills"), "user"],
          ]),
        ),
      ),
    skillsFolder: (project, scope) =>
      scopeFolder(project, scope).pipe(Effect.map((folder) => path.join(folder, "skills"))),
    decode: (entry) => ({ ...entry, type: entry["transport"] ?? entry["type"] }),
    encode: (server) => {
      const { type: _type, ...entry } = toMcpJson(server);
      return { transport: server.transport, ...entry };
    },
  });
});
