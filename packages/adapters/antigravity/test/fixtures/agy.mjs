#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { basename } from "node:path";

const args = process.argv.slice(2);
const scenario = basename(process.argv[1]);
if (args[0] === "--version") {
  console.log(scenario === "agy-old" ? "1.4.9" : "1.5.12");
  process.exit(0);
}
assert.equal(args[0], "acp");
assert.equal(args.includes("--dangerously-skip-permissions"), false);

const sessionId = "acp-fixture";
const configOptions = [
  {
    id: "model",
    currentValue: "fixture-flash",
    options: [
      { value: "fixture-flash", name: "Fixture Flash" },
      { value: "fixture-pro", name: "Fixture Pro" },
    ],
  },
  { id: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
  {
    id: "mode",
    currentValue: "auto",
    options: [{ value: "default" }, { value: "accept-edits" }, { value: "auto" }],
  },
  { id: "future-toggle", currentValue: false },
];
const models = {
  currentModelId: "fixture-flash-high",
  availableModels: [
    { modelId: "fixture-flash-high", name: "Fixture Flash (High)" },
    { modelId: "fixture-flash-low", name: "Fixture Flash (Low)" },
    { modelId: "fixture-pro-high", name: "Fixture Pro (High)" },
  ],
};
const tool = {
  toolCallId: "call-fixture",
  name: "run_command",
  title: "Print the fixture value",
  kind: "execute",
  rawInput: { CommandLine: "printf fixture" },
};
let turn;
let allowTurn = false;

const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const result = (id, value) => send({ id, result: value });
const update = (update) => send({ method: "session/update", params: { sessionId, update } });

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result: answer, error } = JSON.parse(line);
  switch (method) {
    case "initialize":
      assert.equal(params.protocolVersion, 1);
      assert.equal(params.clientCapabilities.fs, undefined);
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, close: {} },
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
      });
      break;
    case "session/new":
    case "session/resume":
      if (scenario === "agy-logged-out") {
        send({ id, error: { code: -32000, message: "Authentication required" } });
        break;
      }
      if (method === "session/resume") assert.equal(params.sessionId, sessionId);
      if (params.mcpServers.length > 0) {
        assert.ok(args.includes("--process-per-session"));
        assert.deepEqual(params.mcpServers, [
          {
            type: "http",
            name: "fixture",
            url: "http://127.0.0.1:9999/mcp",
            headers: [{ name: "X-Fixture", value: "test" }],
          },
        ]);
        assert.equal(params._meta.antigravity.systemPrompt.append, "Fixture instructions");
      }
      result(id, { sessionId, configOptions, models });
      break;
    case "session/set_config_option": {
      const config = configOptions.find((candidate) => candidate.id === params.configId);
      assert.ok(config.options.some((option) => option.value === params.value));
      config.currentValue = params.value;
      result(id, { configOptions });
      break;
    }
    case "session/prompt":
      if (params.prompt.some((part) => part.text === "exit")) process.exit(2);
      assert.notEqual(configOptions[2].currentValue, "auto");
      turn = id;
      allowTurn = params.prompt.some((part) => part.text === "Allow the fixture");
      if (params.prompt.some((part) => part.text === "resume")) {
        assert.equal(configOptions[0].currentValue, "fixture-pro");
        assert.equal(configOptions[1].currentValue, "high");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed." } });
        result(id, { stopReason: "end_turn" });
        break;
      }
      assert.equal(configOptions[1].currentValue, "low");
      assert.deepEqual(params.prompt[1], { type: "image", mimeType: "image/png", data: "eA==" });
      update({ sessionUpdate: "future_update", value: true });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking." } });
      update({ sessionUpdate: "tool_call", ...tool, status: "in_progress" });
      send({
        id: "approve-fixture",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: tool,
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "persistent", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      break;
    case "session/cancel":
      result(turn, { stopReason: "cancelled" });
      break;
    case "session/close":
      result(id, {});
      break;
    default:
      if (id !== "approve-fixture") assert.fail(JSON.stringify({ method, id, error }));
      if (answer.outcome.outcome === "cancelled") break;
      assert.equal(answer.outcome.optionId, allowTurn ? "once" : "reject");
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: tool.toolCallId,
        status: allowTurn ? "completed" : "failed",
      });
      update({ sessionUpdate: "usage_update", used: 40, size: 100 });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: allowTurn ? "Allowed" : "Denied" },
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      result(turn, {
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 5, cachedReadTokens: 2, totalTokens: 37 },
      });
  }
}
