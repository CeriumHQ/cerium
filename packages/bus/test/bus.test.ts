import type { McpServerSpec } from "@cerium/harness";
import {
  Adapters,
  Catalog,
  Orchestrator,
  OrchestratorConfig,
  UserSettings,
  Worktrees,
  Checkpoints,
} from "@cerium/orchestrator";
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
    Layer.provideMerge(UserSettings.layer),
    Layer.provide(
      Layer.mergeAll(
        Store.layer({
          filename: ":memory:",
          migrationsFolder: join(import.meta.dirname, "../../store/migrations"),
        }),
        Adapters.fromList([fake.adapter]),
        Worktrees.unavailable,
        Checkpoints.unavailable,
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
      const data = response.headers.get("content-type")?.includes("text/event-stream")
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

/** The bus endpoint of the fake's `index`th session, once that session starts behind its thread. */
const busOf = (fake: ReturnType<typeof makeFakeAdapter>, index: number) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < 250 && fake.sessions[index] === undefined; waited++) {
      yield* Effect.sleep(Duration.millis(20));
    }
    return fake.sessions[index]?.options.mcpServers["cerium"];
  });

// Each test builds the whole stack, which takes seconds on a busy CI runner.
describe("Cerium MCP bus", { timeout: 30_000 }, () => {
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
      const leadClient = mcpClient(yield* busOf(fake, 0));
      yield* leadClient.initialize;

      const tools = yield* leadClient.request("tools/list", {});
      assert.sameMembers(
        (tools?.result?.tools ?? []).map((tool: { name: string }) => tool.name),
        [
          "list_models",
          "spawn_agent",
          "create_thread",
          "list_agents",
          "list_threads",
          "send_message",
          "kill_agent",
          "answer_permission",
          "ask_advisor",
          "ask_user",
          "artifact_guide",
          "artifact_preview",
        ],
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

      const childClient = mcpClient(yield* busOf(fake, 1));
      yield* childClient.initialize;
      const refused = yield* childClient.callTool("spawn_agent", { role: "x", model: "scout", prompt: "no" });
      assert.isTrue(refused?.result?.isError);
      assert.include(JSON.stringify(refused?.result?.content), "Only a thread's lead can spawn agents.");

      const unasked = yield* leadClient.callTool("answer_permission", {
        agentId: childId,
        requestId: "p9",
        decision: "allowForSession",
      });
      assert.isTrue(unasked?.result?.isError);
      assert.include(JSON.stringify(unasked?.result?.content), "isn't waiting on request p9");

      // Threads whose lead can't take messages are left out of the list.
      const thread = (title: string) =>
        orchestrator.createThread({
          title,
          mode: "work",
          cwd: ".",
          lead: { provider: "claude", model: "opus", access: "ask" },
        });
      yield* thread("Working");
      yield* orchestrator.stopAgent((yield* thread("Stopped")).lead.id);
      const threads = yield* leadClient.callTool("list_threads");
      assert.sameMembers(
        threads?.result?.structuredContent?.threads?.map((listed: { title: string }) => listed.title),
        ["Bus", "Working"],
      );

      const anonymous = yield* leadClient.callTool("list_agents", {}, { authorization: "Bearer forged" });
      assert.isTrue(anonymous?.result?.isError);
      assert.include(JSON.stringify(anonymous?.result?.content), "Unknown Cerium agent.");
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });

  it.live("puts questions to the user's advisor once they turn it on", () => {
    const fake = makeFakeAdapter("claude", {
      reply: (text, session) => (session.access === "readOnly" ? "Check the lockfile." : `lead saw: ${text}`),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      const { lead } = yield* orchestrator.createThread({
        title: "Advice",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "auto" },
      });
      const client = mcpClient(yield* busOf(fake, 0));
      yield* client.initialize;

      const off = yield* client.callTool("ask_advisor", { question: "Why won't it install?" });
      assert.isTrue(off?.result?.isError);
      assert.include(JSON.stringify(off?.result?.content), "hasn't turned on an advisor");

      yield* settings.update({ advisor: { enabled: true, model: { provider: "claude", model: "opus" } } });
      const asked = yield* client.callTool("ask_advisor", { question: "Why won't it install?" });
      assert.strictEqual(asked?.result?.structuredContent?.status, "asked");
      const advisorId = asked?.result?.structuredContent?.advisorId as AgentId;
      assert.strictEqual((yield* orchestrator.agent(advisorId)).access, "readOnly");
      for (
        let waited = 0;
        waited < 100 && !fake.sessions[0]!.sent.some((sent) => sent.includes("Check the lockfile."));
        waited++
      ) {
        yield* Effect.sleep(Duration.millis(20));
      }
      assert.include(
        fake.sessions[0]!.sent.join("\n"),
        `[Cerium] Message from agent ${advisorId} (thread ${lead.threadId}):\nCheck the lockfile.`,
      );
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });

  it.live("puts an agent's questions to the user and hands the answer back as its next turn", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Questions",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      const client = mcpClient(yield* busOf(fake, 0));
      yield* client.initialize;

      const asked = yield* client.callTool("ask_user", {
        questions: [
          {
            header: " Database ",
            question: "Which database should the cache use?",
            options: [
              { label: "SQLite (Recommended)", description: "Already a dependency" },
              { label: "Redis" },
            ],
          },
        ],
      });
      assert.strictEqual(asked?.result?.structuredContent?.status, "asked");
      const requestId = asked?.result?.structuredContent?.requestId as string;
      const history = yield* orchestrator.threadEvents(lead.threadId);
      assert.deepStrictEqual(history.find((event) => event.payload._tag === "QuestionAsked")?.payload, {
        _tag: "QuestionAsked",
        requestId,
        questions: [
          {
            header: "Database",
            question: "Which database should the cache use?",
            options: [
              { label: "SQLite (Recommended)", description: "Already a dependency" },
              { label: "Redis" },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      });

      // Asking nothing breaks the tool's schema, so the call itself is refused.
      const empty = yield* client.callTool("ask_user", { questions: [] });
      assert.isUndefined(empty?.result?.structuredContent);
      assert.isTrue(empty?.error !== undefined || empty?.result?.isError === true);

      yield* orchestrator.answerQuestion(lead.id, requestId, {
        outcome: "answered",
        answers: [{ choices: ["Redis"], text: "we run it already" }],
      });
      for (
        let waited = 0;
        waited < 100 && !fake.sessions[0]!.sent.some((sent) => sent.includes("Answer: Redis"));
        waited++
      ) {
        yield* Effect.sleep(Duration.millis(20));
      }
      assert.include(
        fake.sessions[0]!.sent.join("\n"),
        "- Which database should the cache use?\n  Answer: Redis, we run it already",
      );
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });
});
