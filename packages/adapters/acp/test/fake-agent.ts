// A scripted ACP agent over stdio for the tests: it speaks just enough of ACP v1 to drive a whole
// Cerium session without a real harness. Each prompt's text picks what it does:
//   "hello"   two message chunks, a thought, a usage update, then end_turn with usage
//   "edit"    an edit tool call that asks permission; completes with a diff when allowed, fails if not
//   "run"     a command that asks permission (for the session-grant test)
//   "mcp"     a call to the injected `cerium` server's `ping` tool, which asks permission
//   "wait"    a chunk, then waits for session/cancel and answers `cancelled`
//   "/compact" a compaction, reported with compaction_update
//   "plan"    a plan update
// Every request it receives is appended to $FAKE_ACP_LOG as one JSON line. $FAKE_ACP_SIGNED_OUT=1 makes
// session/new fail as a signed-out agent does.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env["FAKE_ACP_LOG"];
const signedOut = process.env["FAKE_ACP_SIGNED_OUT"] === "1";

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId: string, value: Record<string, unknown>) =>
  send({ method: "session/update", params: { sessionId, update: value } });

let nextId = 1000;
const waiting = new Map<number, (result: any) => void>();
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const cancelled = new Map<string, () => void>();
let sessions = 0;

const configOptions = (model: string, effort: string) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "fake-fast", name: "Fake Fast", description: "Quick" },
      { value: "fake-smart", name: "Fake Smart" },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

const setup = (model = "fake-fast", effort = "medium") => ({
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "read-only", name: "Read only" },
    ],
  },
  configOptions: configOptions(model, effort),
});

const prompt = async (id: number | string, sessionId: string, text: string) => {
  if (text.includes("hello")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } });
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.01, currency: "USD" },
    });
    return send({
      id,
      result: {
        stopReason: "end_turn",
        usage: {
          totalTokens: 150,
          inputTokens: 100,
          outputTokens: 40,
          thoughtTokens: 10,
          cachedReadTokens: 30,
        },
      },
    });
  }
  if (text.includes("edit") || text.includes("run") || text.includes("mcp")) {
    const call = text.includes("edit")
      ? {
          toolCallId: "call-edit",
          title: "Edit hello.txt",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/work/hello.txt" }],
          rawInput: { path: "/work/hello.txt" },
        }
      : text.includes("run")
        ? {
            toolCallId: `call-run-${nextId}`,
            title: "Run ls",
            kind: "execute",
            status: "pending",
            rawInput: { command: "ls" },
          }
        : {
            toolCallId: "call-mcp",
            title: "cerium/ping",
            name: "cerium__ping",
            kind: "other",
            status: "pending",
            rawInput: {},
          };
    update(sessionId, { sessionUpdate: "tool_call", ...call });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: call.toolCallId },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId !== "no";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      status: allowed ? "completed" : "failed",
      content:
        allowed && text.includes("edit")
          ? [{ type: "diff", path: "/work/hello.txt", oldText: "hello\n", newText: "hello world\n" }]
          : [{ type: "content", content: { type: "text", text: allowed ? "ok" : "denied" } }],
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: allowed ? "Done." : "Not allowed." },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("wait")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
    await new Promise<void>((resolve) => cancelled.set(sessionId, resolve));
    return send({ id, result: { stopReason: "cancelled" } });
  }
  if (text.startsWith("/compact")) {
    update(sessionId, { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
    update(sessionId, {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "Summary." },
    });
    update(sessionId, { sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("plan")) {
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read", priority: "high", status: "completed" },
        { content: "Write", priority: "medium", status: "in_progress" },
      ],
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo: ${text}` },
  });
  return send({ id, result: { stopReason: "end_turn" } });
};

const handle = async (message: Message) => {
  if (message.method === undefined) {
    if (typeof message.id === "number") waiting.get(message.id)?.(message.result);
    return;
  }
  if (log) appendFileSync(log, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", version: "1.2.3" },
          authMethods: [{ id: "login", name: "Log in" }],
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: true },
            sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
          },
        },
      });
    case "session/new":
      if (signedOut) return send({ id, error: { code: -32000, message: "Authentication required" } });
      return send({ id, result: { sessionId: `fake-${++sessions}`, ...setup() } });
    case "session/resume":
    case "session/fork":
      return send({
        id,
        result: {
          ...(method === "session/fork" ? { sessionId: `fork-${++sessions}` } : {}),
          ...setup("fake-smart"),
        },
      });
    case "session/load":
      update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "First question" },
      });
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First answer" },
      });
      update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "old-1",
        title: "Read a.txt",
        kind: "read",
        status: "completed",
        locations: [{ path: "/work/a.txt" }],
        content: [{ type: "content", content: { type: "text", text: "A" } }],
      });
      update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Second" },
      });
      update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: " question" },
      });
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second answer" },
      });
      return send({ id, result: setup() });
    case "session/list":
      return send({
        id,
        result: {
          sessions: [
            { sessionId: "old-a", cwd: "/work", title: "Old A", updatedAt: "2026-10-01T10:00:00Z" },
            { sessionId: "old-b", cwd: "/work", title: null, updatedAt: "2026-10-02T10:00:00Z" },
          ],
        },
      });
    case "session/set_mode":
    case "session/close":
    case "session/delete":
      return send({ id, result: {} });
    case "session/set_config_option": {
      const options = configOptions("fake-fast", "medium").map((option) =>
        option.id === params.configId ? { ...option, currentValue: params.value } : option,
      );
      return send({ id, result: { configOptions: options } });
    }
    case "session/prompt":
      return prompt(
        id!,
        params.sessionId,
        (params.prompt as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join(""),
      );
    case "session/cancel":
      cancelled.get(params.sessionId)?.();
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() !== "") void handle(JSON.parse(line) as Message);
});
process.stdin.on("end", () => process.exit(0));
