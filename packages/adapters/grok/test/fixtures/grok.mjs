#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { join } from "node:path";

// An ACP peer shaped like the installed Grok 1.0.70. It asserts the client contract before replying.
if (process.argv.includes("--version")) {
  console.log("grok 1.0.70 (fixture) [stable]");
  process.exit(0);
}
const args = process.argv.slice(2);
if (args[1] === "mcp" || args[1] === "inspect") {
  assert.equal(args[0], "--no-auto-update");
  if (args.includes("--json")) assert.equal(process.env.CERIUM_GROK_HUB_TEST_SECRET, undefined);
  if (args[1] === "inspect") {
    assert.deepEqual(args.slice(2), ["--json"]);
    console.log(
      JSON.stringify({
        skills: [
          {
            name: "review",
            description: "Review changes",
            source: { type: "project", path: join(process.cwd(), ".grok", "skills", "review", "SKILL.md") },
            userInvocable: true,
          },
          {
            name: "hidden",
            source: { type: "user", path: join(process.env.GROK_HOME, "skills", "hidden", "SKILL.md") },
            userInvocable: false,
          },
        ],
      }),
    );
  } else if (args[2] === "list") {
    assert.deepEqual(args.slice(3), ["--json"]);
    console.log(
      JSON.stringify([
        {
          name: "remote",
          scope: "user",
          type: "sse",
          url: "https://example.invalid/events",
          enabled: true,
          headers: { Authorization: "fixture-secret", "X-Empty": "" },
        },
      ]),
    );
  } else if (args[2] === "disable") {
    assert.deepEqual(args.slice(3), ["--", "remote"]);
  } else {
    assert.deepEqual(args.slice(2), [
      "add",
      "--scope",
      "project",
      "--transport",
      "sse",
      "--header",
      "Authorization:",
      "--header",
      "X-Empty:",
      "--",
      "remote",
      "https://example.invalid/events",
    ]);
  }
  process.exit(0);
}
assert.deepEqual(args, ["--no-auto-update", "agent", "--no-leader", "stdio"]);
assert.equal(process.env.GROK_SANDBOX_AUTO_ALLOW_BASH, "0");
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const sid = "grok-fixture-session";
const update = (sessionUpdate, fields) =>
  send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate, ...fields } } });
const config = new Map([
  ["model", "grok-fixture"],
  ["reasoning_effort", "high"],
]);
const options = () => Array.from(config, ([id, currentValue]) => ({ id, currentValue }));
const session = () => ({ sessionId: sid, configOptions: options() });
const catalogue = {
  currentModelId: "grok-fixture",
  availableModels: [
    {
      modelId: "grok-fixture",
      name: "Fixture Grok",
      _meta: { reasoningEfforts: [{ value: "high", default: true }, { value: "low" }, { value: "future" }] },
    },
    { modelId: "grok-other", name: "Other Grok" },
  ],
};
let prompt;
let hookId;
let resumed = false;
let authenticated = false;
let taskRunning = false;

const finish = (stopReason) => {
  send({
    id: prompt,
    result: {
      stopReason,
      _meta: { modelId: config.get("model"), inputTokens: 100, cachedReadTokens: 70, outputTokens: 13 },
    },
  });
  prompt = undefined;
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  switch (method) {
    case "initialize":
      assert.equal(params.protocolVersion, 1);
      assert.deepEqual(params.clientCapabilities, {});
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true },
          _meta: { "x.ai/hooks": { blockingEvents: ["pre_tool_use"] } },
        },
        authMethods: process.env.GROK_TEST_LOGOUT ? [{ id: "grok.com" }] : [{ id: "cached_token" }],
        _meta: {
          modelState: catalogue,
          defaultAuthMethodId: process.env.GROK_TEST_LOGOUT ? null : "cached_token",
        },
      });
      break;
    case "authenticate":
      assert.deepEqual(params, { methodId: "cached_token", _meta: { headless: true } });
      authenticated = true;
      reply({ _meta: { email: "discard-this@example.invalid" } });
      break;
    case "session/resume":
    case "session/new": {
      assert(authenticated);
      if (method === "session/new" && params._meta.agentProfile === undefined) {
        assert.deepEqual(params.mcpServers, []);
        reply({ sessionId: "empty-fork" });
        break;
      }
      resumed = method === "session/resume";
      assert.equal(params.sessionId, resumed ? sid : undefined);
      assert.equal(params._meta.rules, "fixture instructions");
      assert.equal(params._meta.yoloMode, false);
      assert.equal(params._meta.autoMode, false);
      assert.equal(params._meta["x.ai/restore_code"], false);
      assert.equal(params._meta.agentProfile.injectDefaultTools, false);
      assert(!params._meta.agentProfile.toolConfig.tools.some(({ id }) => id.includes("task")));
      assert.equal(
        params._meta.agentProfile.toolConfig.tools.some(({ id }) => id.includes("run_terminal")),
        !resumed,
      );
      assert.equal(process.env.GROK_SANDBOX, resumed ? "read-only" : "workspace");
      assert.deepEqual(params.mcpServers, [
        {
          type: "http",
          name: "cerium",
          url: "http://127.0.0.1:9512/mcp",
          headers: [{ name: "Authorization", value: "Bearer fixture" }],
        },
      ]);
      if (resumed) update("agent_message_chunk", { content: { type: "text", text: "old history" } });
      reply(session());
      break;
    }
    case "session/list":
      assert(authenticated);
      reply({ sessions: [{ sessionId: sid, title: "Saved Grok", cwd: "/grok-project" }] });
      break;
    case "session/load":
      assert.equal(params.sessionId, sid);
      assert.deepEqual(params.mcpServers, []);
      assert.equal(params._meta["x.ai/restore_code"], false);
      update("user_message_chunk", {
        content: { type: "text", text: "Imported prompt" },
        _meta: { promptIndex: 0 },
      });
      update("agent_message_chunk", { content: { type: "text", text: "Imported answer" } });
      reply(session());
      break;
    case "_x.ai/session/fork":
      assert.equal(params.sourceSessionId, sid);
      assert.equal(params.sourceCwd, "/grok-project");
      assert.equal(params.newCwd, "/grok-project");
      assert.equal(params.targetPromptIndex, 1);
      reply({ newSessionId: "forked-grok" });
      break;
    case "_x.ai/btw":
      assert.equal(params.sessionId, sid);
      assert.equal(params.question, "Only reference the transcript.\n\nWhat happened?");
      reply({ result: { answer: "The original session stayed put." } });
      break;
    case "_x.ai/compact_conversation":
      assert.deepEqual(params, { session_id: sid });
      reply({});
      break;
    case "_x.ai/mcp/list":
      assert.deepEqual(params, { sessionId: sid });
      reply({
        result: {
          servers: [
            {
              name: "remote",
              headers: { Authorization: "fixture-secret" },
              session: {
                enabled: true,
                status: "ready",
                tools: [{ name: "echo", description: "Echo text" }],
              },
            },
            { name: "pending", session: { enabled: true, status: "initializing" } },
          ],
        },
      });
      break;
    case "_x.ai/task/list":
      assert.deepEqual(params, { sessionId: sid });
      reply({
        result: {
          tasks: taskRunning
            ? [
                {
                  task_id: "task-fixture",
                  owner_session_id: sid,
                  completed: false,
                  is_backgrounded: true,
                  kind: "bash",
                  command: "sleep 40",
                  description: "Wait",
                  output: "ignore",
                  start_time: { secs_since_epoch: 20, nanos_since_epoch: 2_000_000 },
                },
                {
                  task_id: "task-someone-else",
                  owner_session_id: "other",
                  completed: false,
                  is_backgrounded: true,
                },
              ]
            : [],
        },
      });
      break;
    case "_x.ai/task/kill":
      assert.deepEqual(params, { sessionId: sid, taskId: "task-fixture" });
      taskRunning = false;
      reply({ result: { taskId: params.taskId, outcome: "killed" } });
      break;
    case "session/set_config_option":
      assert.equal(params.sessionId, sid);
      assert(config.has(params.configId));
      assert.equal(typeof params.value, "string");
      config.set(params.configId, params.value);
      reply({ configOptions: options() });
      break;
    case "session/prompt": {
      assert.equal(params.sessionId, sid);
      assert.equal(params._meta.verbatim, true);
      prompt = id;
      const text = params.prompt[0].text;
      if (text === "background fixture") {
        taskRunning = true;
        send({ method: "_x.ai/task_backgrounded", params: { sessionId: sid } });
        finish("end_turn");
        break;
      }
      if (text === "allow this" || text === "always-only") {
        const toolCall = { toolCallId: "permission", title: "Write fixture", name: "run_terminal_cmd" };
        const permanent = { kind: "allow_always", optionId: "always" };
        send({
          id: text,
          method: "session/request_permission",
          params: {
            sessionId: sid,
            toolCall,
            options:
              text === "allow this" ? [permanent, { kind: "allow_once", optionId: "once" }] : [permanent],
          },
        });
        break;
      }
      if (text === "cancel this") {
        send({
          id: "cancel-pending",
          method: "session/request_permission",
          params: {
            sessionId: sid,
            toolCall: { toolCallId: "cancel", title: "Wait", name: "run_terminal_cmd" },
            options: [{ kind: "reject_once", optionId: "deny" }],
          },
        });
        break;
      }
      if (text === "exit unexpectedly") process.exit(42);
      assert.equal(resumed ? text : params._meta.promptId, resumed ? "resumed" : "fixture-turn");
      if (!resumed) {
        assert.deepEqual(params.prompt[1], { type: "image", mimeType: "image/png", data: "YWJj" });
        assert.equal(config.get("reasoning_effort"), "low");
      }
      update("future_update", { unknown: true });
      update("agent_thought_chunk", { content: { type: "text", text: "thinking" } });
      update("tool_call", {
        toolCallId: "shell",
        title: "Run command",
        rawInput: { command: "touch marker" },
        _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
      });
      hookId = resumed ? "read-only-hook" : "shell-hook";
      send({
        method: "_x.ai/hooks/run",
        id: hookId,
        params: {
          hookCallbackId: params._meta.hookCallbackId ?? "cerium-pre-tool-use",
          sessionId: sid,
          toolName: "run_terminal_cmd",
          toolUseId: "shell",
          toolInput: { command: "touch marker" },
        },
      });
      break;
    }
    case "session/cancel":
      assert.equal(params.sessionId, sid);
      assert.equal(id, undefined);
      finish("cancelled");
      break;
    case "session/close":
      assert(["empty-fork", sid].includes(params.sessionId));
      reply({});
      break;
    case undefined:
      if (id === "allow this" || id === "always-only") {
        assert.deepEqual(
          message.result.outcome,
          id === "allow this" ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" },
        );
        finish("end_turn");
        break;
      }
      if (id === "cancel-pending") {
        assert.deepEqual(message.result.outcome, { outcome: "cancelled" });
        break;
      }
      assert.equal(id, hookId);
      assert.equal(message.result.decision, "deny");
      update("tool_call_update", {
        toolCallId: "shell",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "denied" } }],
      });
      update("agent_message_chunk", { content: { type: "text", text: "DEN" } });
      update("agent_message_chunk", { content: { type: "text", text: "IED" } });
      finish("end_turn");
      break;
    default:
      throw new Error(`Unexpected method: ${method}`);
  }
}
