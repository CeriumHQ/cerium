// Hand-built ACP fixture, not a recorded signed-in turn. initialize.json was captured live from
// Google's standalone ACP 1.4.5. Fail if Cerium prompts before enforcing default permission mode.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const initialized = JSON.parse(readFileSync(new URL("./initialize.json", import.meta.url), "utf8"));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
let model = "gemini-flash",
  mode = "yolo",
  effort = "medium",
  next = 1000;
const waiting = new Map();
const ask = (params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    send({ id, method: "session/request_permission", params });
  });
const configOptions = () => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: [
      { value: "default", name: "Default" },
      { value: "yolo", name: "YOLO" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "gemini-flash", name: "Gemini Flash" },
      { value: "gemini-pro", name: "Gemini Pro" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: (model === "gemini-flash" ? ["low", "medium", "high"] : ["high", "max"]).map((value) => ({
      value,
      name: value,
    })),
  },
];
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params: p } = message;
  const ok = (result) => send({ id, result });
  if (method === "initialize") return ok(initialized);
  if (method === "session/new" || method === "session/resume" || method === "session/load") {
    mode = "yolo";
    const sessionId = p.sessionId ?? "agy-session";
    if (method === "session/load") {
      update(sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Remember PELICAN" },
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Remembered PELICAN" },
      });
    }
    return ok({ sessionId, configOptions: configOptions() });
  }
  if (method === "session/set_config_option") {
    if (p.configId === "mode") mode = p.value;
    if (p.configId === "model") {
      model = p.value;
      effort = model === "gemini-pro" ? "high" : "medium";
    }
    if (p.configId === "thinking") effort = p.value;
    return ok({ configOptions: configOptions() });
  }
  if (method === "session/list")
    return ok({
      sessions: [
        {
          sessionId: "agy-session",
          cwd: process.cwd(),
          title: "Native history",
          updatedAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
  if (method === "session/cancel") {
    for (const resolve of waiting.values()) resolve({ outcome: { outcome: "cancelled" } });
    return;
  }
  if (method === "session/prompt") {
    if (mode !== "default") return send({ id, error: { code: -32603, message: "Unsafe inherited mode" } });
    const text = p.prompt[0].text;
    let answer = text;
    if (text === "question") {
      const response = await ask({
        sessionId: p.sessionId,
        toolCall: { toolCallId: "interaction_choice", title: "Choose a destination", kind: "other" },
        options: [
          { optionId: "first", name: "First destination", kind: "allow_once" },
          { optionId: "second", name: "Second destination", kind: "allow_once" },
        ],
      });
      answer = response?.outcome?.outcome === "cancelled" ? "Question cancelled" : "Picked a destination";
    }
    if (text === "edit" || text === "mcp") {
      const call =
        text === "edit"
          ? {
              toolCallId: "edit-1",
              title: "Edit sample.txt",
              kind: "edit",
              rawInput: { TargetFile: "/work/sample.txt" },
            }
          : { toolCallId: "mcp-1", name: "mcp__cerium__list_agents", kind: "other", rawInput: {} };
      update(p.sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
      const result = await ask({
        sessionId: p.sessionId,
        toolCall: call,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const allowed = result?.outcome?.optionId === "allow";
      update(p.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: call.toolCallId,
        status: allowed ? "completed" : "failed",
      });
      answer = allowed ? "Allowed" : "Denied";
    }
    if (text === "image")
      answer = p.prompt.some((block) => block.type === "image") ? "Image received" : "No image";
    update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
    return ok({ stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 5, cachedReadTokens: 10 } });
  }
  if (id !== undefined) ok({});
});
