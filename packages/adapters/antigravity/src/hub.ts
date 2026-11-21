import { makeJsonMcpHub, projectFolders, readAcpSkillFolders } from "@cerium/acp";
import { blankValues } from "@cerium/harness";
import { Effect, Path } from "effect";
import { homedir } from "node:os";

import { antigravityHarness } from "./manifest.ts";

/** Antigravity's loose MCP and skill customizations. Plugins are managed by the CLI. */
export const makeAntigravityHub = Effect.fn("Antigravity.hub")(function* (home = homedir()) {
  const path = yield* Path.Path;
  const user = path.join(home, ".gemini", "config");
  const workspace = (folder: string) => path.join(folder, ".agents");
  const customizations = (project: string) =>
    projectFolders(project).pipe(
      Effect.map((folders) =>
        folders.flatMap((folder) =>
          [".agents", ".agent", "_agents", "_agent"].map((name) => path.join(folder, name)),
        ),
      ),
    );

  return yield* makeJsonMcpHub({
    harness: antigravityHarness,
    files: (project) =>
      customizations(project).pipe(
        Effect.map((folders) => [
          ...folders.map((folder) => [path.join(folder, "mcp_config.json"), "project"] as const),
          [path.join(user, "mcp_config.json"), "user"] as const,
        ]),
      ),
    copyFile: (project, scope) =>
      Effect.succeed(path.join(scope === "user" ? user : workspace(project), "mcp_config.json")),
    skills: (project) =>
      customizations(project).pipe(
        Effect.flatMap((folders) =>
          readAcpSkillFolders([
            ...folders.map((folder) => [path.join(folder, "skills"), "project"] as const),
            [path.join(user, "skills"), "user"],
            [path.join(home, ".gemini", "antigravity-cli", "skills"), "user"],
            [path.join(home, ".gemini", "skills"), "user"],
          ]),
        ),
      ),
    skillsFolder: (project, scope) =>
      Effect.succeed(path.join(scope === "user" ? user : workspace(project), "skills")),
    decode: (entry) => ({ ...entry, url: entry["serverUrl"] ?? entry["url"] }),
    encode: (server) => {
      if (server.transport === "sse") return undefined;
      return server.transport === "stdio"
        ? { command: server.command, args: server.args ?? [], env: blankValues(server.env) }
        : { serverUrl: server.url, headers: blankValues(server.headers) };
    },
  });
});
