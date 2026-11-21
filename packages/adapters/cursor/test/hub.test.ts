import { portable } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "vite-plus/test";
import { Effect, FileSystem, Path } from "effect";
import { join } from "node:path";

import { makeCursorHub } from "../src/hub.ts";

it("uses Cursor's project disabled-server list while keeping server credentials in their config", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-cursor-hub-" });
      const home = join(root, "home");
      const project = join(root, "checkout");
      const nested = join(project, "subdir");
      const other = join(root, "other");
      const data = join(root, "cursor-data");
      yield* fs.makeDirectory(join(home, ".cursor"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.makeDirectory(join(project, ".git"));
      yield* fs.makeDirectory(other);
      const userFile = join(home, ".cursor", "mcp.json");
      yield* fs.writeFileString(
        userFile,
        JSON.stringify({
          mcpServers: { test: { command: "fixture", env: { TOKEN: "secret-fixture" } } },
        }),
      );
      const hub = makeCursorHub(platform, home, data);
      if (!hub.setServer || !hub.addServer) throw new Error("Missing Cursor Hub operation");
      const [server] = (yield* hub.read(nested)).servers;
      if (!server) throw new Error("Missing fixture server");
      expect(server).toMatchObject({ enabled: true, env: [{ name: "TOKEN", set: true }] });
      expect(JSON.stringify(server)).not.toContain("secret-fixture");
      yield* hub.setServer(nested, server, false);
      expect((yield* hub.read(project)).servers[0]?.enabled).toBe(false);
      expect((yield* hub.read(other)).servers[0]?.enabled).toBe(true);
      yield* hub.setServer(project, server, true);
      expect((yield* hub.read(project)).servers[0]?.enabled).toBe(true);
      expect(yield* fs.readFileString(userFile)).toContain("secret-fixture");
      const destination = yield* hub.addServer(nested, "project", portable(server));
      expect(destination).toBe(join(project, ".cursor", "mcp.json"));
      expect(JSON.parse(yield* fs.readFileString(destination))).toMatchObject({
        mcpServers: { test: { command: "fixture", env: { TOKEN: "" } } },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));
