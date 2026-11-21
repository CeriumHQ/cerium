import { parseJsonc, portable } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";

import { makeAntigravityHub } from "../src/hub.ts";

it("reads native Antigravity folders and edits JSONC with secret values kept local", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = join(root, "home");
      const project = join(root, "project");
      const nested = join(project, "nested");
      const userFile = join(home, ".gemini", "config", "mcp_config.json");
      const skill = join(project, ".agents", "skills", "review", "SKILL.md");
      yield* fs.makeDirectory(join(project, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested);
      yield* fs.makeDirectory(dirname(userFile), { recursive: true });
      yield* fs.makeDirectory(dirname(skill), { recursive: true });
      yield* fs.writeFileString(skill, "---\nname: review\ndescription: Check changes\n---\n");
      yield* fs.writeFileString(
        userFile,
        `{
      // Personal MCP settings
      "mcpServers": {"api": {"serverUrl": "https://example.invalid/mcp", "headers": {"Authorization": "private-token", "X-Empty": ""}}}
    }`,
      );

      const { hub, listSkills } = yield* makeAntigravityHub(home);
      const { servers, skills } = yield* hub.read(nested);
      const [server] = servers;
      if (server === undefined) throw new Error("Missing configured server");
      expect(server).toMatchObject({
        name: "api",
        transport: "http",
        scope: "user",
        enabled: true,
        headers: [
          { name: "Authorization", set: true },
          { name: "X-Empty", set: false },
        ],
      });
      expect(JSON.stringify(servers)).not.toContain("private-token");
      expect(skills).toMatchObject([{ name: "review", path: dirname(skill), scope: "project" }]);
      expect(yield* listSkills(nested)).toEqual([
        { name: "review", description: "Check changes", path: skill },
      ]);
      expect(yield* hub.skillsFolder!(project, "user")).toBe(join(dirname(userFile), "skills"));

      yield* hub.setServer!(nested, server, false);
      yield* hub.setTool!(nested, server, "search", false);
      expect((yield* hub.read(nested)).servers[0]).toMatchObject({
        enabled: false,
        disabledTools: ["search"],
      });
      yield* hub.setServer!(nested, server, true);
      yield* hub.setTool!(nested, server, "search", true);
      expect(yield* fs.readFileString(userFile)).toContain("// Personal MCP settings");
      expect(yield* fs.readFileString(userFile)).toContain("private-token");

      const target = yield* hub.addServer!(project, "project", portable(server));
      expect(target).toBe(join(project, ".agents", "mcp_config.json"));
      expect(parseJsonc(yield* fs.readFileString(target))).toEqual({
        mcpServers: {
          api: { serverUrl: "https://example.invalid/mcp", headers: { Authorization: "", "X-Empty": "" } },
        },
      });
      expect((yield* Effect.flip(hub.addServer!(project, "project", portable(server))))._tag).toBe(
        "HubConflict",
      );
      expect(
        (yield* Effect.flip(hub.addServer!(project, "project", { ...portable(server), transport: "sse" })))
          .message,
      ).toContain("does not support sse");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));
