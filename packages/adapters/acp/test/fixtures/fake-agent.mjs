// A scripted ACP agent for the session tests: answers what Cerium sends over stdio, one JSON message
// per line, and plays a turn chosen by the prompt's text.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const options = { model: "fake-a", effort: "medium" };
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: options.model,
    options: [
      { value: "fake-a", name: "Fake A", description: "The quick one" },
      { value: "fake-b", name: "Fake B" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: options.effort,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "extra_high", name: "Extra High" },
    ],
  },
];

let cancelTurn;

const turns = {
  hello: async (sessionId) => {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.25, currency: "USD" },
    });
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 110, inputTokens: 100, outputTokens: 10, cachedReadTokens: 40 },
    };
  },
  write: async (sessionId) => {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Write a.txt",
      kind: "edit",
      status: "pending",
      rawInput: { path: "a.txt", content: "x" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      content: [{ type: "diff", path: "a.txt", oldText: null, newText: "x" }],
    });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", title: "Write a.txt", kind: "edit" },
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
        { optionId: "no", name: "No", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId !== "no";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: allowed ? "completed" : "failed",
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: allowed ? "Wrote it" : "Refused" },
    });
    return { stopReason: allowed ? "end_turn" : "cancelled" };
  },
  mcp: async (sessionId) => {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "list agents",
      name: "mcp__cerium__list_agents",
      kind: "other",
      status: "pending",
    });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t2" },
      options: [
        { optionId: "once", name: "Once", kind: "allow_once" },
        { optionId: "no", name: "No", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.optionId === "once";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: "no agents" } }],
    });
    return { stopReason: "end_turn" };
  },
  wait: (sessionId) =>
    new Promise((resolve) => {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
      cancelTurn = () => resolve({ stopReason: "cancelled" });
    }),
};

const history = (sessionId) => {
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First " } });
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "First answer" },
  });
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second" } });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "h1",
    title: "Read a.txt",
    kind: "read",
    status: "completed",
    locations: [{ path: "a.txt" }],
    content: [{ type: "content", content: { type: "text", text: "x" } }],
  });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It says x" } });
};

const handle = async ({ id, method, params }) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [],
        agentInfo: { name: "fake", version: "1.0.0" },
      };
    case "session/new": {
      if (params?._meta?.signedOut)
        throw Object.assign(new Error("Authentication required"), { code: -32000 });
      const sessionId = `s-${id}`;
      // Sent right after the answer, before Cerium can attach to the session.
      setImmediate(() =>
        update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact" }],
        }),
      );
      return { sessionId, configOptions: configOptions() };
    }
    case "session/set_config_option":
      if (params.configId === "model") options.model = params.value;
      if (params.configId === "effort") options.effort = params.value;
      return { configOptions: configOptions() };
    case "session/resume":
      return { configOptions: configOptions() };
    case "session/load":
      history(params.sessionId);
      return {};
    case "session/list":
      return {
        sessions: [
          { sessionId: "old", cwd: "/work", title: "An old one", updatedAt: "2026-10-01T10:00:00Z" },
          { sessionId: "new", cwd: "/work", title: null, updatedAt: "2026-10-30T10:00:00Z" },
        ],
      };
    case "session/close":
      return {};
    case "session/prompt": {
      const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
      const turn = turns[text];
      if (turn === undefined) throw Object.assign(new Error(`No turn named ${text}`), { code: -32602 });
      return turn(params.sessionId);
    }
    default:
      throw Object.assign(new Error(`Unknown method ${method}`), { code: -32601 });
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    cancelTurn?.();
    return;
  }
  handle(message).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
});
