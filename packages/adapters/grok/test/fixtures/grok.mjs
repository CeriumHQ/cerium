#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";

// An ACP peer shaped like the installed Grok 1.0.70. It asserts the client contract before replying.
if (process.argv.includes("--version")) {
  console.log("grok 1.0.70 (fixture) [stable]");
  process.exit(0);
}
assert.deepEqual(process.argv.slice(2), ["--no-auto-update", "agent", "--no-leader", "stdio"]);
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
          sessionCapabilities: { resume: {} },
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
