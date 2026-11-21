import { portable } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "vite-plus/test";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";

import { makeMuseHub } from "../src/hub.ts";
import { listMuseSkills } from "../src/skills.ts";

describe.skipIf(process.platform === "win32")("Muse Hub", () => {
  it("edits the native MCP files and uses Muse skill activation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const platform = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
        >();
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-muse-hub-" });
        const config = join(root, "config");
        const project = join(root, "workspace");
        const nested = join(project, "nested");
        yield* fs.makeDirectory(config);
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.makeDirectory(join(project, ".git"));
        const userFile = join(config, "settings.json");
        yield* fs.writeFileString(
          userFile,
          JSON.stringify(
            {
              schema_version: 1,
              mcpServers: {
                docs: {
                  type: "streamable-http",
                  url: "https://example.com/mcp",
                  headers: { Authorization: "fixture-secret" },
                  disabled_tools: ["search"],
                },
              },
            },
            null,
            2,
          ),
        );
        const executable = join(root, "muse");
        yield* fs.writeFileString(
          executable,
          [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            'const activation = require("node:path").join(__dirname, "activation");',
            "const [, , command, action, ...args] = process.argv;",
            'if (command !== "skills" || !args.includes("--trust-workspace")) process.exit(1);',
            'if (action === "list") {',
            '  const state = fs.existsSync(activation) ? fs.readFileSync(activation, "utf8") : "user-invocable-only";',
            '  console.log(JSON.stringify({ skills: [{ id: "review", scope: "project", path: ".agents/skills/review/SKILL.md", description: "Review changes", activation: state }, { id: "bundled:git", scope: "bundled", path: "bundled://skills/git/SKILL.md", activation: "on" }] }));',
            '} else if (args[0].endsWith("SKILL.md") && args[2] === "project") {',
            '  fs.writeFileSync(activation, action === "enable" ? "on" : "off");',
            "} else process.exit(1);",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);
        const hub = makeMuseHub(Effect.succeed(executable), platform, () => config);
        if (!hub.addServer || !hub.setServer || !hub.setTool || !hub.setSkill || !hub.skillsFolder)
          throw new Error("Missing Hub operation");
        const { servers, skills } = yield* hub.read(nested);
        const source = servers[0];
        const skill = skills[0];
        if (!source || !skill) throw new Error("Fixture did not load");
        expect(source).toMatchObject({
          name: "docs",
          transport: "http",
          headers: [{ name: "Authorization", set: true }],
          disabledTools: ["search"],
        });
        expect(JSON.stringify(source)).not.toContain("fixture-secret");
        expect(yield* hub.skillsFolder(nested, "project")).toBe(join(nested, ".agents", "skills"));
        expect(yield* hub.skillsFolder(nested, "user")).toBe(join(config, "skills"));
        const destination = yield* hub.addServer(nested, "project", {
          ...portable(source),
          name: "docs-copy",
        });
        expect(destination).toBe(join(project, ".mcp.json"));
        expect(JSON.parse(yield* fs.readFileString(destination))).toEqual({
          mcpServers: {
            "docs-copy": {
              type: "streamable-http",
              url: "https://example.com/mcp",
              headers: { Authorization: "" },
            },
          },
        });
        expect(
          (yield* hub
            .addServer(nested, "project", { ...portable(source), name: "docs-copy" })
            .pipe(Effect.flip))._tag,
        ).toBe("HubConflict");
        expect(
          (yield* hub.addServer(nested, "user", { ...portable(source), transport: "sse" }).pipe(Effect.flip))
            ._tag,
        ).toBe("HarnessFailure");
        yield* hub.setServer(nested, source, false);
        yield* hub.setTool(nested, source, "search", true);
        expect((yield* hub.read(nested)).servers[0]).toMatchObject({ enabled: false, disabledTools: [] });
        yield* hub.setServer(nested, source, true);
        expect(yield* fs.readFileString(userFile)).toContain("fixture-secret");
        expect((yield* hub.read(nested)).servers[0]?.enabled).toBe(true);
        expect(yield* listMuseSkills(executable, nested)).toEqual([
          {
            name: "review",
            path: join(nested, ".agents", "skills", "review", "SKILL.md"),
            description: "Review changes",
          },
          { name: "git" },
        ]);
        yield* hub.setSkill(nested, skill, false);
        expect(yield* listMuseSkills(executable, nested)).toEqual([{ name: "git" }]);
        yield* hub.setSkill(nested, skill, true);
        expect((yield* hub.read(nested)).skills[0]?.enabled).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
});
