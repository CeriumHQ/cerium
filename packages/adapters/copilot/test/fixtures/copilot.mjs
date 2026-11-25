#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const cli = process.env.CERIUM_COPILOT_E2E_CLI;
const trace = process.env.CERIUM_COPILOT_E2E_TRACE;
const modelUrl = process.env.CERIUM_COPILOT_E2E_MODEL_URL;
process.on("uncaughtExceptionMonitor", (error) => {
  appendFileSync(trace, JSON.stringify({ fixtureError: String(error) }) + "\n");
});
const connect = (input, output) =>
  createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output));

if (process.argv.includes("--version")) {
  if (!cli) {
    process.stdout.write("GitHub Copilot CLI 1.0.114.\n");
  } else {
    const child = spawn(cli, process.argv.slice(2), { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
  }
} else {
  assert(process.argv.includes("--headless") && process.argv.includes("--stdio"));
  assert(process.argv.includes("--sync-session=off"));
  assert.equal(process.env.COPILOT_ALLOW_ALL, undefined);

  const adapter = connect(process.stdin, process.stdout);
  const models = {
    models: [
      { id: "fixture/gpt-4o", name: "Fixture 4o" },
      {
        id: "fixture/gpt-4.1",
        name: "Fixture 4.1",
        supportedReasoningEfforts: ["high", "low", "future"],
        defaultReasoningEffort: "high",
      },
      {
        id: "fixture/gpt-4.1-fast",
        name: "Fixture 4.1 (fast mode)",
        supportedReasoningEfforts: ["high", "low"],
        defaultReasoningEffort: "high",
      },
      { id: "blocked", name: "Blocked", policy: { state: "disabled" } },
    ],
  };

  // With the real CLI, replace only account and inference. All session, permission, event and
  // filesystem behavior comes from the installed binary and the loopback model.
  let runtime;
  if (cli) {
    const child = spawn(cli, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (data) =>
      appendFileSync(trace, JSON.stringify({ cliStderr: data.toString() }) + "\n"),
    );
    runtime = connect(child.stdout, child.stdin);
    runtime.onNotification((method, params) => {
      if (
        method === "session.event" &&
        [
          "assistant.message_delta",
          "assistant.usage",
          "permission.requested",
          "permission.completed",
          "tool.execution_complete",
          "session.idle",
          "session.resume",
        ].includes(params?.event?.type)
      ) {
        appendFileSync(
          trace,
          JSON.stringify({ event: params.event.type, sessionId: params.sessionId, data: params.event.data }) +
            "\n",
        );
      }
      return adapter.sendNotification(method, params);
    });
    runtime.listen();
    process.stdin.on("end", () => child.stdin.end());
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
    child.on("close", (code) => process.exit(code ?? 0));
  }

  let opened;
  let prompt;
  let permissionId;
  let sequence = 0;
  const home = process.env.COPILOT_HOME;
  if (!runtime) mkdirSync(home, { recursive: true });
  const journalFile = resolve(home, "fixture-journal.json");
  const settingsFile = resolve(home, "fixture-settings.json");
  const userMcpFile = resolve(home, "mcp-config.json");
  const read = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
  const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
  // Each session's persisted journal, which the session listing, history and forks read.
  const journals = new Map([
    [
      "user-session",
      {
        meta: {
          startTime: "2026-01-02T03:04:05.000Z",
          summary: "Fix the build",
          context: { cwd: "/work/app" },
        },
        events: [
          { id: "u-1", type: "session.start", data: { selectedModel: "gpt-4.1" } },
          { id: "u-2", type: "user.message", data: { content: "run the tests" } },
          { id: "u-3", type: "user.message", data: { content: "skill text", source: "skill-pdf" } },
          { id: "u-4", type: "assistant.message", data: { messageId: "m-1", content: "All green." } },
          { id: "u-5", type: "session.idle", data: {} },
        ],
      },
    ],
  ]);
  for (const [id, journal] of read(journalFile, [])) journals.set(id, journal);
  const saveJournals = () => {
    if (!runtime)
      write(
        journalFile,
        [...journals].filter(([id]) => id !== "user-session"),
      );
  };
  const persisted = new Set([
    "user.message",
    "assistant.message",
    "session.idle",
    "session.compaction_complete",
  ]);
  const event = (sessionId, type, data = {}) => {
    const id = String(++sequence);
    if (persisted.has(type) && journals.has(sessionId)) {
      journals.get(sessionId).events.push({ id, type, data });
      saveJournals();
    }
    return adapter.sendNotification("session.event", { sessionId, event: { id, type, data } });
  };
  let todos = [];
  let tasks = [];
  const skills = [
    {
      name: "review",
      description: "Review a diff",
      source: "project",
      userInvocable: true,
      enabled: true,
      path: "/work/app/.github/skills/review/SKILL.md",
    },
    {
      name: "hidden",
      description: "Agent only",
      source: "personal-copilot",
      userInvocable: false,
      enabled: true,
      path: "/home/.copilot/skills/hidden/SKILL.md",
    },
    { name: "off", description: "Turned off", source: "builtin", userInvocable: true, enabled: false },
  ];
  const discover = (project) => {
    const settings = read(settingsFile, {});
    const files = [
      [userMcpFile, "user"],
      [resolve(project, ".mcp.json"), "workspace"],
    ];
    return files.flatMap(([file, source]) =>
      Object.entries(read(file, {}).mcpServers ?? {}).map(([name, config]) => ({
        name,
        source,
        type: config.type ?? (config.url ? "http" : "stdio"),
        enabled: !settings.disabledServers?.includes(name),
        effectiveSource: {
          file: {
            uri: pathToFileURL(file).href,
            jsonPointer: `/mcpServers/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          },
        },
      })),
    );
  };
  const toggle = (key, names, disabled) => {
    const settings = read(settingsFile, {});
    const list = new Set(settings[key]);
    for (const name of names) {
      if (disabled) list.add(name);
      else list.delete(name);
    }
    write(settingsFile, { ...settings, [key]: [...list] });
  };
  const end = async (sessionId, aborted = false) => {
    if (!aborted) {
      const messageId = `message-${sequence}`;
      await event(sessionId, "assistant.message_delta", { messageId, deltaContent: "fixture reply" });
      await event(sessionId, "assistant.message", { messageId, content: "fixture reply" });
      await event(sessionId, "assistant.usage", { inputTokens: 24, outputTokens: 3, cacheReadTokens: 4 });
    }
    await event(sessionId, "session.idle", { mode: "interactive", aborted });
  };

  adapter.onRequest(async (method, input) => {
    assert(input && !Array.isArray(input));
    let params = input;
    appendFileSync(trace, JSON.stringify({ method, params }) + "\n");
    const { sessionId } = params ?? {};
    if (method === "auth.getStatus") {
      if (process.env.CERIUM_COPILOT_E2E_LOGOUT !== "true") return { isAuthenticated: true };
      return runtime ? runtime.sendRequest(method, params) : { isAuthenticated: false };
    }
    if (method === "models.list") return models;
    if (runtime) {
      if (method === "session.create" || method === "session.resume") {
        params = Object.assign({}, params, {
          github: { ...params.github, capi: { enabled: false } },
          inference: {
            ...params.inference,
            defaultProvider: "fixture",
            providers: [{ name: "fixture", type: "openai", baseUrl: modelUrl, apiKey: "fixture" }],
            models: models.models
              .slice(0, 2)
              .map(({ id }) => ({ id: id.split("/")[1], provider: "fixture" })),
          },
        });
      }
      return runtime.sendRequest(method, params);
    }

    switch (method) {
      case "connect":
        return { protocolVersion: 4 };
      case "mcp.discover":
        return { servers: discover(params.workingDirectory ?? process.cwd()) };
      case "session.mcp.listConfigured": {
        return {
          servers: discover(opened.workingDirectory).map((server) => ({
            ...server,
            enabled: server.enabled && !opened.mcp?.disabledServers?.includes(server.name),
          })),
        };
      }
      case "session.mcp.list":
        return {
          servers: discover(opened.workingDirectory).map((server) => ({
            name: server.name,
            status: server.enabled ? "connected" : "disabled",
          })),
        };
      case "session.mcp.listTools":
        return { tools: [{ name: "echo", description: "Echo fixture text" }] };
      case "session.create":
      case "session.resume":
        opened = params;
        if (!journals.has(sessionId)) {
          journals.set(sessionId, {
            meta: {
              startTime: "2026-01-03T00:00:00.000Z",
              clientName: params.clientName,
              context: { cwd: params.workingDirectory },
            },
            events: [
              { id: `start-${sessionId}`, type: "session.start", data: { selectedModel: params.model } },
            ],
          });
          saveJournals();
        }
        return { sessionId };
      case "sessions.list":
        return {
          sessions: [...journals].map(([id, { meta }]) => ({
            sessionId: id,
            modifiedTime: meta.startTime,
            isRemote: false,
            ...meta,
          })),
        };
      case "sessions.readPersistedEvents":
        return {
          events: journals.get(params.sessionId)?.events ?? [],
          cursor: "end",
          hasMore: false,
          cursorStatus: "ok",
        };
      case "sessions.fork": {
        const source = journals.get(params.sessionId);
        const cut =
          params.toEventId === undefined ? -1 : source.events.findIndex(({ id }) => id === params.toEventId);
        const id = `fork-${journals.size}-${++sequence}`;
        journals.set(id, {
          meta: { ...source.meta, startTime: "2026-01-04T00:00:00.000Z" },
          events: cut < 0 ? [...source.events] : source.events.slice(0, cut),
        });
        saveJournals();
        return { sessionId: id };
      }
      case "sessions.delete":
        journals.delete(params.sessionId);
        saveJournals();
        return {};
      case "session.history.compact":
        await event(sessionId, "session.compaction_start", {});
        await event(sessionId, "session.compaction_complete", {
          success: true,
          trigger: params.trigger,
          preCompactionTokens: 120,
          postCompactionTokens: 30,
          summaryContent: "fixture summary",
        });
        return { success: true, tokensRemoved: 90, messagesRemoved: 2 };
      case "session.plan.readSqlTodos":
        return { rows: todos };
      case "session.tasks.list":
        return { tasks };
      case "session.tasks.cancel": {
        const task = tasks.find(({ id }) => id === params.id);
        if (task) task.status = "cancelled";
        await event(sessionId, "session.background_tasks_changed", {});
        return { cancelled: task !== undefined };
      }
      case "skills.discover":
        return {
          skills: skills.map((skill) => ({
            ...skill,
            enabled: skill.enabled && !read(settingsFile, {}).disabledSkills?.includes(skill.name),
          })),
          errors: [],
        };
      case "session.commands.list":
        return { commands: [{ kind: "skill", name: "review" }] };
      case "session.commands.invoke":
        return { kind: "agent-prompt", prompt: "Use the review fixture skill." };
      case "skills.config.setSkillDisabled":
        toggle("disabledSkills", [params.name], params.disabled);
        return null;
      case "mcp.config.enable":
      case "mcp.config.disable":
        toggle("disabledServers", params.names, method === "mcp.config.disable");
        return null;
      case "mcp.config.add": {
        const config = read(userMcpFile, {});
        write(userMcpFile, { ...config, mcpServers: { ...config.mcpServers, [params.name]: params.config } });
        return null;
      }
      case "session.permissions.getMode":
        return { mode: "manual" };
      case "session.permissions.configure":
      case "session.model.switchTo":
        return { success: true, modelId: params.modelId };
      case "session.send": {
        prompt = params.prompt;
        await event(sessionId, "user.message", {
          content: params.displayPrompt ?? prompt,
          ...(params.clientTurnId === undefined ? {} : { clientTurnId: params.clientTurnId }),
        });
        if (prompt === "plan") {
          todos = [
            { id: "read", title: "Read the failing test", status: "done" },
            { id: "fix", title: "Fix the race", status: "in_progress" },
            { id: "ship", title: "Ship it", status: "blocked" },
          ];
          await event(sessionId, "session.todos_changed", {});
          await end(sessionId);
          return { messageId: "user-message" };
        }
        if (prompt === "background") {
          tasks = [
            {
              type: "shell",
              id: "shell-1",
              description: "Dev server",
              command: "bun run dev",
              status: "running",
              executionMode: "background",
              attachmentMode: "detached",
              startedAt: "2026-01-03T00:00:01.000Z",
            },
            {
              type: "shell",
              id: "shell-2",
              description: "Waited on",
              command: "ls",
              status: "running",
              executionMode: "sync",
              attachmentMode: "attached",
              startedAt: "2026-01-03T00:00:02.000Z",
            },
          ];
          await event(sessionId, "session.background_tasks_changed", {});
          await end(sessionId);
          return { messageId: "user-message" };
        }
        if (prompt.startsWith("write ") && !opened.tools.availableTools) {
          const fileName = resolve(opened.workingDirectory, prompt.slice("write ".length));
          permissionId = `permission-${sequence}`;
          await event(sessionId, "tool.execution_start", {
            toolCallId: "create",
            toolName: "create",
            arguments: { path: fileName },
          });
          await event(sessionId, "permission.requested", {
            requestId: permissionId,
            permissionRequest: {
              kind: "write",
              toolCallId: "create",
              fileName,
              canOfferSessionApproval: true,
            },
          });
        } else {
          await end(sessionId);
        }
        return { messageId: "user-message" };
      }
      case "session.permissions.handlePendingPermissionRequest": {
        assert.equal(params.requestId, permissionId);
        const allowed = params.result.kind === "approve-once";
        await event(sessionId, "permission.completed", {
          requestId: permissionId,
          result: { kind: allowed ? "approved" : "denied-interactively-by-user" },
        });
        const fileName = resolve(opened.workingDirectory, prompt.slice("write ".length));
        if (allowed) writeFileSync(fileName, "fixture");
        await event(sessionId, "tool.execution_complete", {
          toolCallId: "create",
          success: allowed,
          ...(allowed ? { fileEdits: [{ path: fileName, kind: "create" }] } : {}),
        });
        await end(sessionId);
        return { success: true };
      }
      case "session.abort":
        await end(sessionId, true);
        return {};
      case "session.detach":
        return { success: true };
      case "session.delete":
        journals.delete(sessionId);
        saveJournals();
        return { success: true };
      default:
        throw new Error(`Unexpected RPC method ${method}`);
    }
  });
  adapter.listen();
}
