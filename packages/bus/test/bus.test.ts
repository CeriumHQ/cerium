import type { McpServerSpec } from "@cerium/harness";
import {
  Adapters,
  Catalog,
  Orchestrator,
  OrchestratorConfig,
  ProjectScripts,
  UserSettings,
  Worktrees,
  Checkpoints,
} from "@cerium/orchestrator";
import type { AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFakeAdapter } from "@cerium/harness/testing";
import {
  BROWSER_UNAVAILABLE,
  BrowserHost,
  BusHttpServer,
  BusRegistryLive,
  BusServer,
  PushHost,
} from "../src/index.ts";

const stack = (fake: ReturnType<typeof makeFakeAdapter>) =>
  BusServer.pipe(
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(BusRegistryLive),
    Layer.provideMerge(BrowserHost.layer),
    Layer.provideMerge(PushHost.unavailable),
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
        ProjectScripts.unavailable,
        Catalog.fromEntries([
          {
            alias: "scout",
            provider: "claude",
            model: "haiku",
            speed: "fast",
            description: "Quick lookups",
            priority: 1,
          },
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
    while (fake.sessions[index] === undefined) yield* Effect.sleep(Duration.millis(20));
    return fake.sessions[index].options.mcpServers["cerium"];
  });

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
      const leadClient = mcpClient(yield* busOf(fake, 0));
      yield* leadClient.initialize;

      const tools = yield* leadClient.request("tools/list", {});
      assert.sameMembers(
        (tools?.result?.tools ?? []).map((tool: { name: string }) => tool.name),
        [
          "workspace_status",
          "list_workspaces",
          "link_pull_request",
          "unlink_pull_request",
          "watch_pull_request",
          "unwatch_pull_request",
          "review_changes",
          "move_to_workspace",
          "link_issue",
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
          "add_task",
          "remove_task",
          "list_tasks",
          "project_run",
          "push",
          "artifact_preview",
          "browser_open",
          "browser_read",
          "browser_act",
          "browser_screenshot",
          "browser_logs",
        ],
      );

      const models = yield* leadClient.callTool("list_models");
      assert.deepStrictEqual(models?.result?.structuredContent?.models, [
        {
          alias: "scout",
          provider: "claude",
          model: "haiku",
          speed: "fast",
          description: "Quick lookups",
          priority: 1,
        },
      ]);

      const spawned = yield* leadClient.callTool("spawn_agent", {
        role: "scout",
        model: "scout",
        prompt: "Capital of France?",
      });
      assert.strictEqual(spawned?.result?.structuredContent?.status, "spawned");
      const childId = spawned?.result?.structuredContent?.agentId as AgentId;
      assert.strictEqual((yield* orchestrator.agent(childId)).parentId, lead.id);
      const workerClient = mcpClient(yield* busOf(fake, 1));
      yield* workerClient.initialize;
      const workerTools = yield* workerClient.request("tools/list", {});
      const names = (workerTools?.result?.tools ?? []).map((t: { name: string }) => t.name);
      assert.notInclude(names, "spawn_agent");
      assert.notInclude(names, "create_thread");
      assert.notInclude(names, "answer_permission");
      assert.notInclude(names, "watch_pull_request");
      assert.notInclude(names, "move_to_workspace");
      assert.includeMembers(names, ["workspace_status", "list_workspaces", "review_changes"]);
      assert.includeMembers(names, ["send_message", "browser_act", "browser_screenshot"]);

      const agents = yield* leadClient.callTool("list_agents");
      assert.deepStrictEqual(
        agents?.result?.structuredContent?.agents?.map((agent: { you: boolean }) => agent.you),
        [true, false],
      );

      // The project's scripts are the backend's: without them the tool says so, and it takes only its actions.
      const run = yield* leadClient.callTool("project_run", { action: "status" });
      assert.isTrue(run?.result?.isError);
      assert.include(JSON.stringify(run?.result?.content), "Scripts aren't available here.");
      const launched = yield* leadClient.callTool("project_run", { action: "launch" });
      assert.include(launched?.error?.message, "Invalid parameters for tool 'project_run'");

      const childClient = mcpClient(yield* busOf(fake, 1));
      yield* childClient.initialize;
      const refused = yield* childClient.callTool("spawn_agent", { role: "x", model: "scout", prompt: "no" });
      assert.isDefined(refused?.error);
      assert.include(JSON.stringify(refused?.error), "spawn_agent");

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

  it.live("drives the thread's browser through the window hosting it, and says when none does", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const browser = yield* BrowserHost;
      const { lead } = yield* orchestrator.createThread({
        title: "Browser",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      const client = mcpClient(yield* busOf(fake, 0));
      yield* client.initialize;

      const alone = yield* client.callTool("browser_open", { url: "localhost:5173" });
      assert.isTrue(alone?.result?.isError);
      assert.include(JSON.stringify(alone?.result?.content), BROWSER_UNAVAILABLE);

      // A window hosts it: each call reaches it for the agent's own thread, and its answer comes back.
      const seen: Array<unknown> = [];
      yield* browser.host.pipe(
        Stream.runForEach((call) => {
          if (call === undefined) return Effect.void;
          seen.push(call);
          return browser.answer(call.requestId, { _tag: "Done", text: "Page: Todo", image: "iVBORw0KGgo=" });
        }),
        Effect.forkScoped,
      );
      yield* Effect.sleep(Duration.millis(20));
      const shot = yield* client.callTool("browser_screenshot", { fullPage: true });
      assert.deepStrictEqual(shot?.result?.content, [
        { type: "text", text: "Page: Todo" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
      assert.deepInclude(seen[0] as object, {
        threadId: lead.threadId,
        command: { _tag: "Screenshot", fullPage: true, review: { session: lead.id } },
      });

      const bad = yield* client.callTool("browser_act", { steps: [{ action: "teleport" }] });
      assert.isTrue(bad?.result?.isError);
      assert.include(JSON.stringify(bad?.result?.content), "Give `steps`");
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
      while (!fake.sessions[0]!.sent.some((sent) => sent.includes("Check the lockfile."))) {
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
      while (!fake.sessions[0]!.sent.some((sent) => sent.includes("Answer: Redis"))) {
        yield* Effect.sleep(Duration.millis(20));
      }
      assert.include(
        fake.sessions[0]!.sent.join("\n"),
        "- Which database should the cache use?\n  Answer: Redis, we run it already",
      );
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });

  it.live("adds a task to the user's list, lists it and takes it off again", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      yield* orchestrator.createThread({
        title: "Tasks",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      const client = mcpClient(yield* busOf(fake, 0));
      yield* client.initialize;

      const empty = yield* client.callTool("list_tasks");
      assert.deepStrictEqual(empty?.result?.structuredContent?.tasks, []);

      assert.deepStrictEqual(
        (yield* client.callTool("list_tasks", {}, { authorization: "Bearer forged" }))?.result?.isError,
        true,
      );

      const added = yield* client.callTool("add_task", {
        title: "  Fix the login page  ",
        note: "After the reporting work is reviewed",
      });
      const task = added?.result?.structuredContent?.task;
      assert.isDefined(task?.id);
      assert.isDefined(task?.updatedAt);
      assert.include(task?.task?.title, "Fix the login page");

      const listed = yield* client.callTool("list_tasks");
      assert.deepStrictEqual(listed?.result?.structuredContent?.tasks, [
        {
          id: task?.id,
          title: "Fix the login page",
          note: "After the reporting work is reviewed",
          createdAt: task?.task?.createdAt,
          updatedAt: task?.updatedAt,
        },
      ]);

      const alike = yield* client.callTool("add_task", { title: "fix the LOGIN page" });
      const second = alike?.result?.structuredContent?.task;
      const doubled = yield* client.callTool("remove_task", { title: "Fix the login page" });
      assert.isTrue(doubled?.result?.isError);
      assert.include(JSON.stringify(doubled?.result?.content), task?.id);

      const removed = yield* client.callTool("remove_task", { id: task?.id });
      const gone = removed?.result?.structuredContent?.removed;
      assert.strictEqual(gone?.id, task?.id);
      assert.isTrue(gone?.task === undefined);

      const missing = yield* client.callTool("remove_task", { title: "Never was" });
      assert.isTrue(missing?.result?.isError);
      assert.include(JSON.stringify(missing?.result?.content), "list_tasks");

      const rest = yield* client.callTool("list_tasks");
      assert.deepStrictEqual(
        rest?.result?.structuredContent?.tasks?.map((kept: { id: string }) => kept.id),
        [second?.id],
      );
    }).pipe(Effect.provide(stack(fake)), Effect.scoped);
  });
});
