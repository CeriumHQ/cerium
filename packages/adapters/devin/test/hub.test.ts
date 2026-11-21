import { parseJsonc, portable } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";

import { makeDevinHub } from "../src/hub.ts";

it("reads Devin's local, project, user and legacy files and copies blank credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const user = join(root, "profile", "config.json");
      const project = join(root, "project");
      const nested = join(project, "nested");
      const localFile = join(project, ".devin", "mcp_config.local.json");
      const skill = join(project, ".devin", "skills", "fixture", "SKILL.md");
      for (const folder of [dirname(user), dirname(skill), join(project, ".git"), nested]) {
        yield* fs.makeDirectory(folder, { recursive: true });
      }
      yield* fs.writeFileString(skill, "---\nname: fixture\ndescription: Fixture skill\n---\n");
      yield* fs.writeFileString(
        user,
        '{"mcpServers":{"legacy":{"command":"legacy","env":{"KEY":"legacy-secret"}}}}',
      );
      yield* fs.writeFileString(
        join(project, ".devin", "mcp_config.json"),
        '{"mcpServers":{"shared":{"command":"global"},"remote":{"url":"https://example.invalid/events","transport":"sse","headers":{"Authorization":"remote-secret"}}}}',
      );
      yield* fs.writeFileString(
        localFile,
        '{\n// local override\n"mcpServers":{"shared":{"command":"private","transport":"stdio","disabled":true,"disabledTools":["read"]}}\n}',
      );

      const { hub, listSkills } = yield* makeDevinHub(user, root);
      const { servers } = yield* hub.read(nested);
      expect(servers).toMatchObject([
        { name: "legacy", scope: "user", env: [{ name: "KEY", set: true }] },
        {
          name: "remote",
          scope: "project",
          transport: "sse",
          headers: [{ name: "Authorization", set: true }],
        },
        { name: "shared", scope: "local", command: "private", disabledTools: ["read"], enabled: false },
      ]);
      expect(JSON.stringify(servers)).not.toContain("-secret");
      const [, remote, shared] = servers;
      if (remote === undefined || shared === undefined) throw new Error("Missing configured servers");
      yield* hub.setServer!(nested, shared, true);
      yield* hub.setTool!(nested, shared, "read", true);
      expect((yield* hub.read(nested)).servers.at(-1)).toMatchObject({ enabled: true, disabledTools: [] });
      expect(yield* fs.readFileString(localFile)).toContain("// local override");
      const written = yield* hub.addServer!(nested, "user", portable(remote));
      expect(written).toBe(join(dirname(user), "mcp_config.json"));
      expect(parseJsonc(yield* fs.readFileString(written))).toEqual({
        mcpServers: {
          remote: { url: "https://example.invalid/events", transport: "sse", headers: { Authorization: "" } },
        },
      });
      expect(yield* hub.skillsFolder!(nested, "project")).toBe(join(project, ".devin", "skills"));
      expect(yield* listSkills(nested)).toEqual([
        { name: "fixture", description: "Fixture skill", path: skill },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));
