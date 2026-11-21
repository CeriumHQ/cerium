#!/usr/bin/env node
// Plays `devin acp` as the real CLI does over ACP, from what Devin CLI 3000.14 sent in a live session.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const scenario = basename(process.argv[1]);
if (args[0] === "--version") {
  console.log("devin 3000.14.30821 (a09cd7f323ee)");
  process.exit(0);
}
const configAt = args[0] === "--config" ? args[1] : undefined;
const rest = configAt === undefined ? args : args.slice(2);
assert.deepEqual(rest, ["acp", "--process-model", "in-process"]);
const config = configAt === undefined ? undefined : JSON.parse(readFileSync(configAt, "utf8"));

const variants = {
  "fixture-swe": { thought: ["medium", "high", "max"], effort: "high", speed: ["standard", "fast"] },
  "fixture-opus": { thought: ["none", "low", "medium", "high", "xhigh", "max"], effort: "medium" },
};
const models = [
  { value: "fixture-swe", name: "Fixture SWE", _meta: { "cognition.ai/supportsImages": true } },
  { value: "fixture-opus", name: "Fixture Opus", _meta: { "cognition.ai/supportsImages": false } },
];
const modes = ["accept-edits", "smart", "ask", "plan", "bypass"];

const sessions = new Map();
let nextSession = 1;
let turn;

const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const result = (id, value) => send({ id, result: value });
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });

const configOptions = (state) => {
  const variant = variants[state.model];
  return [
    {
      id: "mode",
      type: "select",
      currentValue: state.mode,
      options: modes.map((value) => ({ value, name: value })),
    },
    { id: "model", type: "select", currentValue: state.model, options: models },
    {
      id: "thought_level",
      type: "select",
      currentValue: state.effort,
      options: variant.thought.map((value) => ({ value, name: value })),
    },
    ...(variant.speed === undefined
      ? []
      : [
          {
            id: "speed",
            type: "select",
            currentValue: state.speed,
            options: variant.speed.map((value) => ({ value })),
          },
        ]),
  ];
};

const open = (cwd, sessionId = `fixture-${nextSession++}`) => {
  const state = {
    cwd,
    mode: "accept-edits",
    model: "fixture-swe",
    effort: "high",
    speed: "standard",
    prompts: 0,
  };
  sessions.set(sessionId, state);
  return { sessionId, state };
};

const permission = (sessionId, toolCallId, rule) => {
  const id = `perm-${toolCallId}`;
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId, _meta: { "cognition.ai/permissionRule": rule } },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "allow_session", name: "Allow for the session", kind: "allow_always" },
        { optionId: "switch_bypass", name: "Switch to bypass", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  return id;
};

const toolCall = (sessionId, toolCallId, inferenceToolName, rawInput, extra = {}) =>
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: `Ran ${inferenceToolName}`,
    kind: "execute",
    rawInput,
    _meta: { "cognition.ai/inferenceToolName": inferenceToolName },
    ...extra,
  });

const settle = (sessionId, toolCallId, outcome) =>
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: outcome === "allow_once" ? "completed" : "failed",
    content: [
      { type: "content", content: { type: "text", text: outcome === "allow_once" ? "ok" : "rejected" } },
    ],
  });

const finishTurn = (stopReason = "end_turn") => {
  const { id, sessionId } = turn;
  turn = undefined;
  update(sessionId, { sessionUpdate: "usage_update", used: 900, size: 200000 });
  result(id, {
    stopReason,
    usage: {
      totalTokens: 140,
      inputTokens: 120,
      outputTokens: 20,
      cachedReadTokens: 100,
      cachedWriteTokens: 4,
    },
  });
};

const runPrompt = async (id, params) => {
  const { sessionId, prompt } = params;
  const state = sessions.get(sessionId);
  const text = prompt[0].text;
  const opened = text.includes("<cerium_instructions>");
  assert.equal(opened, state.prompts === 0, "Cerium's instructions open the first turn only");
  if (opened) assert.match(text, /Fixture instructions/);
  state.prompts += 1;
  const pending = new Map();
  turn = { id, sessionId, onReply: (replyId, outcome) => pending.get(replyId)?.(outcome) };
  const ask = (toolCallId, rule) =>
    new Promise((resolve) => pending.set(permission(sessionId, toolCallId, rule), resolve));

  if (text.endsWith("exit")) process.exit(0);
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking." } });
  if (text.endsWith("Cancel this fixture")) {
    toolCall(sessionId, "call-sleep", "exec", { command: "sleep 20" });
    turn.cancel = () => {
      settle(sessionId, "call-sleep", "cancelled");
      finishTurn("cancelled");
    };
    void ask("call-sleep", "Exec(sleep)");
    return;
  }
  if (text.endsWith("Read only")) {
    toolCall(
      sessionId,
      "call-bus",
      "mcp__cerium__spawn",
      {},
      { _meta: { "cognition.ai/toolName": "mcp__cerium__spawn" } },
    );
    toolCall(
      sessionId,
      "call-user",
      "mcp__github__issue",
      {},
      { _meta: { "cognition.ai/toolName": "mcp__github__issue" } },
    );
    const [bus, user] = await Promise.all([
      ask("call-bus", "mcp__cerium__spawn"),
      ask("call-user", "mcp__github__issue"),
    ]);
    settle(sessionId, "call-bus", bus);
    settle(sessionId, "call-user", user);
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${bus} ${user}` },
    });
    finishTurn();
    return;
  }
  toolCall(sessionId, "call-exec", "exec", { command: "npm test" });
  toolCall(
    sessionId,
    "call-bus",
    "mcp__cerium__spawn",
    {},
    { _meta: { "cognition.ai/toolName": "mcp__cerium__spawn" } },
  );
  const [exec, bus] = await Promise.all([
    ask("call-exec", "Exec(npm)"),
    ask("call-bus", "mcp__cerium__spawn"),
  ]);
  settle(sessionId, "call-exec", exec);
  settle(sessionId, "call-bus", bus);
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-write",
    title: "Wrote ./hello.txt",
    kind: "edit",
    content: [{ type: "diff", path: join(state.cwd, "hello.txt"), newText: "hi\n" }],
    rawInput: { file_path: join(state.cwd, "hello.txt"), content: "hi\n" },
    _meta: { "cognition.ai/inferenceToolName": "write" },
  });
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-write", status: "completed" });
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Test", status: "in_progress" }] });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${exec} ` } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: bus } });
  finishTurn();
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result: answer } = JSON.parse(line);
  if (method === undefined) {
    // A reply to one of the fixture's own requests.
    const outcome = answer?.outcome?.optionId ?? "cancelled";
    turn?.onReply(id, outcome);
    continue;
  }
  switch (method) {
    case "initialize":
      assert.equal(params.protocolVersion, 1);
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, delete: {}, close: {} },
        },
        authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
        agentInfo: { name: "affogato", title: "Devin Agent", version: "3000.14.30821" },
      });
      break;
    case "session/new": {
      if (scenario === "devin-logged-out") {
        send({ id, error: { code: -32000, message: "Authentication required" } });
        break;
      }
      const { sessionId, state } = open(params.cwd);
      if (config !== undefined) {
        assert.equal(config.subagents_enabled, false);
        writeFileSync(join(params.cwd, "received-config.json"), JSON.stringify(config));
        writeFileSync(join(params.cwd, "received-mcp.json"), JSON.stringify(params.mcpServers));
      }
      result(id, { sessionId, configOptions: configOptions(state) });
      break;
    }
    case "session/load": {
      const { state } = open(params.cwd, params.sessionId);
      state.prompts = 1;
      // History replays before the response; a client must not take it for a new turn.
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "From the past." },
      });
      result(id, { configOptions: configOptions(state) });
      break;
    }
    case "session/set_config_option": {
      const state = sessions.get(params.sessionId);
      if (params.configId === "mode") state.mode = params.value;
      if (params.configId === "thought_level") state.effort = params.value;
      if (params.configId === "speed") state.speed = params.value;
      if (params.configId === "model") {
        const variant = variants[params.value];
        if (variant === undefined) {
          send({ id, error: { code: -32602, message: "Unknown model" } });
          break;
        }
        state.model = params.value;
        state.effort = variant.effort;
        state.speed = "standard";
      }
      result(id, { configOptions: configOptions(state) });
      break;
    }
    case "session/prompt":
      void runPrompt(id, params);
      break;
    case "session/cancel":
      turn?.cancel?.();
      break;
    case "session/close":
    case "session/delete":
      sessions.delete(params.sessionId);
      result(id, {});
      break;
    default:
      send({ id, error: { code: -32601, message: `Unexpected ${method}` } });
  }
}
