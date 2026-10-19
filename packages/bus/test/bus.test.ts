import type { McpServerSpec } from "@cerium/harness";
import { Adapters, Catalog, Orchestrator, OrchestratorConfig, UserSettings } from "@cerium/orchestrator";
import type { AccessMode, AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFakeAdapter } from "@cerium/harness/testing";
import { BusHttpServer, BusRegistryLive, BusServer } from "../src/index.ts";
import { findBrowser } from "../src/ui/browser.ts";

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
          "list_agents",
          "list_threads",
          "send_message",
          "kill_agent",
          "ask_advisor",
          "artifact_guide",
          "ui_open",
          "ui_act",
          "ui_screenshot",
          "ui_inspect",
          "ui_close",
          "live_check",
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

  /** A lead in its own folder, with its bus client ready. */
  const leadIn = (fake: ReturnType<typeof makeFakeAdapter>, access: AccessMode, cwd: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Checks",
        mode: "work",
        cwd,
        lead: { provider: "claude", model: "opus", access },
      });
      const client = mcpClient(yield* busOf(fake, 0));
      yield* client.initialize;
      return { lead, client };
    });
  const text = (response: { result?: any } | undefined): string => response?.result?.content?.[0]?.text ?? "";

  it.live("runs live checks through the app's adapters, answering now or in a later notice", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const { client } = yield* leadIn(fake, "ask", mkdtempSync(join(tmpdir(), "cerium-folder-")));

      const now = yield* client.callTool("live_check", { providers: ["claude"], prompt: "hi", wait: true });
      assert.include(text(now), "Live check finished (app):\nPASS claude (fake-model, ask)");
      // The check never runs with more access than its agent has.
      assert.strictEqual(fake.sessions[1]?.options.access, "ask");

      const later = yield* client.callTool("live_check", { providers: ["claude"], prompt: "hi" });
      assert.include(text(later), '"status":"started"');
      for (
        let waited = 0;
        waited < 100 && !fake.sessions[0]!.sent.some((sent) => sent.includes("Live check"));
        waited++
      ) {
        yield* Effect.sleep(Duration.millis(20));
      }
      assert.include(fake.sessions[0]!.sent.join("\n"), "[Cerium] Live check finished (app):\nPASS claude");
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });

  it.live("runs a checkout's own live check only for agents that may run its code", () => {
    const fake = makeFakeAdapter("claude");
    const checkout = mkdtempSync(join(tmpdir(), "cerium-checkout-"));
    mkdirSync(join(checkout, "apps", "backend", "scripts"), { recursive: true });
    const result = {
      provider: "codex",
      model: "gpt-mini",
      access: "auto",
      status: "passed",
      seconds: 1,
      tools: ["shell"],
      approvals: [],
      files: ["shell.txt"],
      problems: [],
    };
    writeFileSync(
      join(checkout, "apps", "backend", "scripts", "live-check.ts"),
      `console.log("checking");\nconsole.log(${JSON.stringify(`LIVE_CHECK_RESULTS ${JSON.stringify([result])}`)});\n`,
    );
    return Effect.gen(function* () {
      const asking = yield* leadIn(fake, "acceptEdits", checkout);
      const refused = yield* asking.client.callTool("live_check", { wait: true });
      assert.isTrue(refused?.result?.isError);
      assert.include(text(refused), "needs Auto or Full access");
    })
      .pipe(Effect.provide(stack(fake)), Effect.scoped)
      .pipe(
        Effect.andThen(() => {
          const trusted = makeFakeAdapter("claude");
          return Effect.gen(function* () {
            const { client } = yield* leadIn(trusted, "auto", checkout);
            const ran = yield* client.callTool("live_check", { wait: true });
            assert.include(text(ran), "Live check finished (workspace):\nPASS codex (gpt-mini, auto)");
            assert.include(text(ran), "files: shell.txt");
          }).pipe(Effect.provide(stack(trusted)), Effect.scoped);
        }),
      );
  });

  it.live.skipIf(findBrowser() === undefined)(
    "drives a page for an agent and shows it the screenshots",
    () => {
      const fake = makeFakeAdapter("claude");
      const page = `<title>Form</title><input placeholder="Name"><button onclick="document.title='Hi ' + document.querySelector('input').value">Greet</button>`;
      return Effect.gen(function* () {
        const { client } = yield* leadIn(fake, "auto", mkdtempSync(join(tmpdir(), "cerium-folder-")));
        const opened = yield* client.callTool("ui_open", {
          url: `data:text/html,${encodeURIComponent(page)}`,
          width: 600,
          height: 400,
        });
        const [info, image] = opened?.result?.content ?? [];
        assert.include(info?.text, '"title":"Form"');
        assert.strictEqual(image?.type, "image");
        assert.strictEqual(image?.mimeType, "image/png");
        assert.isTrue(
          Buffer.from(image?.data ?? "", "base64")
            .subarray(1, 4)
            .equals(Buffer.from("PNG")),
        );

        const acted = yield* client.callTool("ui_act", {
          steps: [
            { action: "type", text: "Name", input: "Ada" },
            { action: "click", text: "Greet" },
          ],
          screenshot: false,
        });
        assert.include(text(acted), '"title":"Hi Ada"');
        assert.strictEqual(acted?.result?.content?.length, 1);

        const failed = yield* client.callTool("ui_act", { steps: [{ action: "click", text: "Nowhere" }] });
        assert.isTrue(failed?.result?.isError);
        assert.include(text(failed), 'Nothing visible matches \\"Nowhere\\".');
        assert.strictEqual(failed?.result?.content?.[1]?.type, "image");

        assert.include(text(yield* client.callTool("ui_close", {})), '"closed":true');
      }).pipe(Effect.provide(stack(fake)), Effect.scoped);
    },
    120_000,
  );

  it.live("keeps read-only agents from acting on pages or running checks", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const { client } = yield* leadIn(fake, "readOnly", mkdtempSync(join(tmpdir(), "cerium-folder-")));
      const act = yield* client.callTool("ui_act", { steps: [{ action: "click", text: "Send" }] });
      assert.include(text(act), "Read-only agents can look at a page but not act on it.");
      const check = yield* client.callTool("live_check", { wait: true });
      assert.include(text(check), "Read-only agents can't run live checks.");
      const closed = yield* client.callTool("ui_screenshot", {});
      assert.include(text(closed), "No page is open. Call ui_open first.");
      const invalid = yield* client.callTool("ui_act", { steps: [] });
      assert.include(text(invalid), "Invalid input");
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });
});
