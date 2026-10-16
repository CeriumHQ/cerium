import type { McpServerSpec } from "@cerium/harness";
import { Adapters, Catalog, Orchestrator, OrchestratorConfig } from "@cerium/orchestrator";
import type { AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFakeAdapter } from "@cerium/harness/testing";
import { BusHttpServer, BusRegistryLive, BusServer } from "../src/index.ts";

const stack = (fake: ReturnType<typeof makeFakeAdapter>) =>
  BusServer.pipe(
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(BusRegistryLive),
    Layer.provide(
      Layer.mergeAll(
        Store.layer({
          filename: ":memory:",
          migrationsFolder: join(import.meta.dirname, "../../store/migrations"),
        }),
        Adapters.fromList([fake.adapter]),
        Catalog.fromEntries([
          { alias: "scout", provider: "claude", model: "haiku", description: "Quick lookups" },
        ]),
        OrchestratorConfig.layer({
          chatDirectory: mkdtempSync(join(tmpdir(), "cerium-chat-")),
          batchWindow: Duration.millis(20),
        }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );

/** A minimal MCP client speaking JSON-RPC over the session's own URL and bearer token. */
const mcpClient = (spec: McpServerSpec | undefined) => {
  if (spec?.type !== "http") throw new Error("Expected an HTTP bus endpoint");
  let sessionId: string | undefined;
  let id = 0;
  const post = (body: object, headers: Record<string, string> = spec.headers ?? {}) =>
    Effect.promise(async () => {
      const response = await fetch(spec.url, {
        method: "POST",
        headers: {
          ...headers,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      const text = await response.text();
      const data = text.includes("data:")
        ? text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5))
            .join("")
        : text;
      return data === "" ? undefined : (JSON.parse(data) as { result?: any; error?: any });
    });
  const request = (method: string, params: object, headers?: Record<string, string>) =>
    post({ id: ++id, method, params }, headers);
  return {
    initialize: Effect.gen(function* () {
      yield* request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      yield* post({ method: "notifications/initialized" });
    }),
    request,
    callTool: (name: string, args: object = {}, headers?: Record<string, string>) =>
      request("tools/call", { name, arguments: args }, headers),
  };
};

describe("Cerium MCP bus", () => {
  it.live("serves the bus tools to each session under its own identity", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Bus",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      const leadClient = mcpClient(fake.sessions[0]?.options.mcpServers["cerium"]);
      yield* leadClient.initialize;

      const tools = yield* leadClient.request("tools/list", {});
      assert.sameMembers(
        (tools?.result?.tools ?? []).map((tool: { name: string }) => tool.name),
        ["list_models", "spawn_agent", "list_agents", "list_threads", "send_message", "kill_agent"],
      );

      const models = yield* leadClient.callTool("list_models");
      assert.deepStrictEqual(models?.result?.structuredContent?.models, [
        { alias: "scout", provider: "claude", model: "haiku", description: "Quick lookups" },
      ]);

      const spawned = yield* leadClient.callTool("spawn_agent", {
        role: "scout",
        model: "scout",
        prompt: "Capital of France?",
      });
      assert.strictEqual(spawned?.result?.structuredContent?.status, "spawned");
      const childId = spawned?.result?.structuredContent?.agentId as AgentId;
      assert.strictEqual((yield* orchestrator.agent(childId)).parentId, lead.id);

      const agents = yield* leadClient.callTool("list_agents");
      assert.deepStrictEqual(
        agents?.result?.structuredContent?.agents?.map((agent: { you: boolean }) => agent.you),
        [true, false],
      );

      const childClient = mcpClient(fake.sessions[1]?.options.mcpServers["cerium"]);
      yield* childClient.initialize;
      const refused = yield* childClient.callTool("spawn_agent", { role: "x", model: "scout", prompt: "no" });
      assert.isTrue(refused?.result?.isError);
      assert.include(JSON.stringify(refused?.result?.content), "Only a thread's lead can spawn agents.");

      const anonymous = yield* leadClient.callTool("list_agents", {}, { authorization: "Bearer forged" });
      assert.isTrue(anonymous?.result?.isError);
      assert.include(JSON.stringify(anonymous?.result?.content), "Unknown Cerium agent.");
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });
});
