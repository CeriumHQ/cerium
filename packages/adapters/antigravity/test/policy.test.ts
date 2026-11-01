import { capabilitiesOf, Initialized } from "@cerium/adapter-acp";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationUrl, checkUserMcp } from "../src/probe.ts";
import { antigravityManifest } from "../src/manifest.ts";

describe("Antigravity discovery and policy", () => {
  it("reads the capabilities captured from the installed signed-out ACP 1.4.5", () => {
    const initialized = Schema.decodeUnknownSync(Initialized)(
      JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "initialize.json"), "utf8")),
    );
    expect(capabilitiesOf(initialized)).toMatchObject({
      load: true,
      resume: true,
      list: true,
      images: true,
      httpMcp: true,
    });
    expect(antigravityManifest).toMatchObject({
      nativeSubagents: "notDisableable",
      compact: false,
      session: { fork: false },
    });
  });
  it("accepts only the harness's Google authorization notice", () => {
    expect(
      authorizationUrl(
        "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=test",
      ),
    ).toContain("accounts.google.com");
    expect(
      authorizationUrl("Open the following link to authenticate the ACP server: https://evil.example/auth"),
    ).toBeUndefined();
    expect(authorizationUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBeUndefined();
  });
  it.live("fails closed when a session excludes global MCP, leaving that config intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-agy-policy-" });
      yield* fs.makeDirectory(join(home, "config"));
      const file = join(home, "config", "mcp_config.json");
      const original = '{"mcpServers":{"user":{"command":"example"}}}';
      yield* fs.writeFileString(file, original);
      const before = process.env["GEMINI_HOME"];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env["GEMINI_HOME"] = home;
        }),
        () =>
          Effect.sync(() => {
            if (before === undefined) delete process.env["GEMINI_HOME"];
            else process.env["GEMINI_HOME"] = before;
          }),
      );
      const result = yield* checkUserMcp(false).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      yield* checkUserMcp(true);
      assert.strictEqual(yield* fs.readFileString(file), original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
