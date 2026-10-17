import type { AdapterEvent } from "@cerium/harness";
import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { handleServerRequest, type RequestContext, type RequestHandling } from "../src/approvals.ts";
import { accessPolicy, ceriumEfforts, fromCodexEffort, threadConfig, toCodexEffort } from "../src/config.ts";
import type { ServerNotification } from "../src/protocol/ServerNotification.ts";
import type { ServerRequest } from "../src/protocol/ServerRequest.ts";
import type { ThreadStartResponse } from "../src/protocol/v2/ThreadStartResponse.ts";
import { CodexTranslator } from "../src/translate.ts";

type Message = { readonly id?: number | string; readonly method?: string; readonly result?: unknown };

/** The recording's workspace, scrubbed to `<workspace>`, stands at a fixed Windows path in the tests. */
const WORKSPACE = String.raw`C:\work`;

const fixture = (name: string): ReadonlyArray<Message> =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .replaceAll("<workspace>", JSON.stringify(WORKSPACE).slice(1, -1))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Message);

const isThreadStart = (message: Message): message is { readonly result: ThreadStartResponse } =>
  typeof message.result === "object" && message.result !== null && "thread" in message.result;

const context = (translator: CodexTranslator, overrides: Partial<RequestContext> = {}): RequestContext => ({
  cwd: WORKSPACE,
  approveWorkspaceEdits: false,
  trustedMcpServers: new Set(["cerium"]),
  item: (itemId) => translator.item(itemId),
  runningMcpCall: (server) => translator.runningMcpCall(server),
  ...overrides,
});

/** Replays a recorded session the way the session does: responses, notifications and server requests. */
const replay = (messages: ReadonlyArray<Message>) => {
  const translator = new CodexTranslator();
  const events: Array<AdapterEvent> = [];
  const requests: Array<RequestHandling> = [];
  for (const message of messages) {
    if (isThreadStart(message)) events.push(...translator.started(message.result));
    else if (message.method !== undefined && message.id !== undefined) {
      requests.push(handleServerRequest(message as ServerRequest, context(translator)));
    } else if (message.method !== undefined) {
      events.push(...translator.translate(message as ServerNotification));
    }
  }
  return { events, requests, payloads: events.map((event) => event.payload) };
};

describe("CodexTranslator on a recorded read/write session", () => {
  const messages = fixture("read-write-session.jsonl");
  const { events, requests, payloads } = replay(messages);

  it("emits only payloads that satisfy the canonical schema", () => {
    for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
  });

  it("keeps the raw provider message on every event", () => {
    for (const event of events) expect(event.raw).toBeDefined();
  });

  it("produces the session lifecycle in order", () => {
    const tags = payloads.map((payload) => payload._tag).filter((tag) => tag !== "MessageDelta");
    expect(tags).toEqual([
      "SessionStarted",
      "ToolCallStarted",
      "ToolCallCompleted",
      "ToolCallStarted",
      "ToolCallCompleted",
      "FileChanged",
      "MessageCompleted",
      "UsageReported",
      "TurnCompleted",
    ]);
  });

  it("starts the session with the thread id, model and effort", () => {
    const started = messages.find(isThreadStart);
    expect(payloads[0]).toEqual({
      _tag: "SessionStarted",
      provider: "codex",
      providerSessionId: started?.result.thread.id,
      model: "gpt-6-luna",
      effort: "low",
    });
  });

  it("reports the read command and the patch with stable call ids", () => {
    const started = payloads.flatMap((payload) => (payload._tag === "ToolCallStarted" ? [payload] : []));
    const completed = payloads.flatMap((payload) => (payload._tag === "ToolCallCompleted" ? [payload] : []));
    expect(started.map((call) => call.toolName)).toEqual(["exec_command", "apply_patch"]);
    expect(completed.map((call) => call.callId)).toEqual(started.map((call) => call.callId));
    expect(started[0]?.input).toMatchObject({ command: "Get-Content -Raw hello.txt" });
    expect(completed.every((call) => !call.isError)).toBe(true);
  });

  it("reports the created file", () => {
    const change = payloads.find((payload) => payload._tag === "FileChanged");
    expect(change).toEqual({ _tag: "FileChanged", path: String.raw`C:\work\out.txt`, change: "created" });
  });

  it("streams text deltas under the same id as the completed message", () => {
    const completed = payloads.find((payload) => payload._tag === "MessageCompleted");
    const deltas = payloads.flatMap((payload) => (payload._tag === "MessageDelta" ? [payload] : []));
    expect(completed?._tag === "MessageCompleted" && completed.text).toBe("HELLO FROM CERIUM");
    expect(deltas.map((delta) => delta.text).join("")).toBe("HELLO FROM CERIUM");
    for (const delta of deltas) {
      expect(delta.messageId).toBe(completed?._tag === "MessageCompleted" ? completed.messageId : undefined);
    }
  });

  it("reports the turn's usage with cache reads separated, then one completed turn", () => {
    // Running totals at the end of the turn: 36,517 input (22,016 of them cached), 134 output.
    expect(payloads.find((payload) => payload._tag === "UsageReported")).toEqual({
      _tag: "UsageReported",
      inputTokens: 14_501,
      outputTokens: 134,
      cachedInputTokens: 22_016,
    });
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(1);
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
  });

  it("asks before the patch and maps the user's decision onto Codex's", () => {
    expect(requests).toHaveLength(1);
    const [ask] = requests;
    if (ask?._tag !== "Ask") throw new Error("expected an approval prompt");
    expect(ask).toMatchObject({ toolName: "apply_patch", summary: "Create out.txt" });
    expect(ask.reply({ decision: "allow", scope: "once" })).toEqual({ decision: "accept" });
    expect(ask.reply({ decision: "allow", scope: "session" })).toEqual({ decision: "acceptForSession" });
    expect(ask.reply({ decision: "deny", scope: "once" })).toEqual({ decision: "decline" });
  });

  it("approves workspace edits without asking in acceptEdits", () => {
    const translator = new CodexTranslator();
    const handled: Array<RequestHandling> = [];
    for (const message of messages) {
      if (isThreadStart(message)) translator.started(message.result);
      else if (message.method !== undefined && message.id !== undefined) {
        handled.push(
          handleServerRequest(message as ServerRequest, context(translator, { approveWorkspaceEdits: true })),
        );
      } else if (message.method !== undefined) translator.translate(message as ServerNotification);
    }
    expect(handled).toEqual([{ _tag: "Reply", result: { decision: "accept" } }]);
  });
});

const notification = (method: string, params: object) =>
  ({ method, params }) as unknown as ServerNotification;
const usage = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const tokenUsage = (turnId: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>) =>
  notification("thread/tokenUsage/updated", { threadId: "t1", turnId, tokenUsage: { total, last } });
const turnCompleted = (turnId: string, status: string, error: object | null = null) =>
  notification("turn/completed", { threadId: "t1", turn: { id: turnId, status, error, items: [] } });

const startedTranslator = () => {
  const translator = new CodexTranslator();
  translator.started({
    thread: { id: "t1" },
    model: "gpt-6-luna",
    reasoningEffort: "ultra",
  } as unknown as ThreadStartResponse);
  return translator;
};
const run = (translator: CodexTranslator, notifications: ReadonlyArray<ServerNotification>) =>
  notifications.flatMap((message) => translator.translate(message).map((event) => event.payload));

describe("CodexTranslator edge cases", () => {
  it("starts the session once and leaves out efforts Cerium has no name for", () => {
    const translator = new CodexTranslator();
    const response = {
      thread: { id: "t1" },
      model: "m",
      reasoningEffort: "ultra",
    } as unknown as ThreadStartResponse;
    const events = [...translator.started(response), ...translator.started(response)];
    expect(events.map((event) => event.payload)).toEqual([
      { _tag: "SessionStarted", provider: "codex", providerSessionId: "t1", model: "m" },
    ]);
  });

  it("ignores other threads' notifications", () => {
    const payloads = run(startedTranslator(), [
      notification("item/agentMessage/delta", { threadId: "other", turnId: "u", itemId: "m", delta: "x" }),
    ]);
    expect(payloads).toEqual([]);
  });

  it("reports each turn's usage from the thread's running totals, also after a resume", () => {
    const translator = startedTranslator();
    // A resumed thread: the first update's total already includes 1,000 input tokens from before.
    const payloads = run(translator, [
      tokenUsage("u1", usage(1_100, 50, 30), usage(100, 50, 10)),
      tokenUsage("u1", usage(1_300, 150, 50), usage(200, 100, 20)),
      turnCompleted("u1", "completed"),
      tokenUsage("u2", usage(1_400, 200, 60), usage(100, 50, 10)),
      turnCompleted("u2", "completed"),
    ]).filter((payload) => payload._tag === "UsageReported");
    expect(payloads).toEqual([
      { _tag: "UsageReported", inputTokens: 150, outputTokens: 30, cachedInputTokens: 150 },
      { _tag: "UsageReported", inputTokens: 50, outputTokens: 10, cachedInputTokens: 50 },
    ]);
  });

  it("reports a rate limit once although both the error and the failed turn carry it", () => {
    const error = {
      message: "Usage limit reached",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    };
    const payloads = run(startedTranslator(), [
      notification("error", { threadId: "t1", turnId: "u1", error, willRetry: false }),
      turnCompleted("u1", "failed", error),
    ]);
    expect(payloads).toEqual([
      { _tag: "AgentError", kind: "rateLimit", message: "Usage limit reached", retryable: true },
      { _tag: "UsageReported", inputTokens: 0, outputTokens: 0 },
      { _tag: "TurnCompleted", stopReason: "error" },
    ]);
  });

  it("skips errors Codex retries itself, and maps lost logins to AuthRequired", () => {
    const retried = {
      message: "Reconnecting",
      codexErrorInfo: { responseStreamDisconnected: {} },
      additionalDetails: null,
    };
    const unauthorized = {
      message: "Token expired",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    };
    const payloads = run(startedTranslator(), [
      notification("error", { threadId: "t1", turnId: "u1", error: retried, willRetry: true }),
      turnCompleted("u1", "failed", unauthorized),
    ]);
    expect(payloads[0]).toEqual({
      _tag: "AuthRequired",
      provider: "codex",
      reason: "Token expired",
      loginCommand: "codex login",
    });
  });

  it("closes tool calls an interruption cut short and reports the turn as interrupted", () => {
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "sleep",
      cwd: ".",
      commandActions: [],
      status: "inProgress",
    };
    const payloads = run(startedTranslator(), [
      notification("item/started", { threadId: "t1", turnId: "u1", item }),
      turnCompleted("u1", "interrupted"),
    ]);
    expect(payloads.map((payload) => payload._tag)).toEqual([
      "ToolCallStarted",
      "ToolCallCompleted",
      "UsageReported",
      "TurnCompleted",
    ]);
    expect(payloads[1]).toMatchObject({ callId: "c1", isError: true });
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
  });

  it("streams reasoning summary parts under the item id and completes with the same text", () => {
    const delta = (summaryIndex: number, text: string) =>
      notification("item/reasoning/summaryTextDelta", {
        threadId: "t1",
        turnId: "u1",
        itemId: "r1",
        delta: text,
        summaryIndex,
      });
    const payloads = run(startedTranslator(), [
      delta(0, "First"),
      delta(1, "Second"),
      notification("item/completed", {
        threadId: "t1",
        turnId: "u1",
        item: { type: "reasoning", id: "r1", summary: ["First", "Second"], content: [] },
      }),
    ]);
    expect(payloads).toEqual([
      { _tag: "ReasoningDelta", messageId: "r1", text: "First" },
      { _tag: "ReasoningDelta", messageId: "r1", text: "\n\nSecond" },
      { _tag: "ReasoningCompleted", messageId: "r1", text: "First\n\nSecond" },
    ]);
  });

  it("names MCP tool calls like Claude so the UI and bus recognise them", () => {
    const item = {
      type: "mcpToolCall",
      id: "m1",
      server: "cerium",
      tool: "spawn_agent",
      status: "inProgress",
      arguments: { role: "x" },
    };
    const [started] = run(startedTranslator(), [
      notification("item/started", { threadId: "t1", turnId: "u1", item }),
    ]);
    expect(started).toEqual({
      _tag: "ToolCallStarted",
      callId: "m1",
      toolName: "mcp__cerium__spawn_agent",
      input: { role: "x" },
    });
  });
});

describe("Session option mapping", () => {
  it("clamps efforts onto what the model supports", () => {
    expect(toCodexEffort("minimal", ["low", "medium", "high"])).toBe("low");
    expect(toCodexEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(toCodexEffort("medium", ["low", "medium"])).toBe("medium");
    expect(toCodexEffort("minimal", undefined)).toBe("minimal");
    expect(ceriumEfforts(["ultra", "max", "low", "none"])).toEqual(["low", "max"]);
    expect(fromCodexEffort("xhigh")).toBe("xhigh");
    expect(fromCodexEffort("ultra")).toBeUndefined();
  });

  it("maps access modes onto sandbox and approval policy", () => {
    expect(accessPolicy("readOnly")).toMatchObject({ sandbox: "read-only", approveWorkspaceEdits: false });
    expect(accessPolicy("readOnly").approvalPolicy).toMatchObject({
      granular: { sandbox_approval: false, mcp_elicitations: true },
    });
    expect(accessPolicy("ask")).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approveWorkspaceEdits: false,
    });
    expect(accessPolicy("acceptEdits")).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approveWorkspaceEdits: true,
    });
    expect(accessPolicy("fullAccess")).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approveWorkspaceEdits: true,
    });
  });

  it("injects Cerium's servers, trusts only the bus and switches the user's servers off", () => {
    const config = threadConfig(
      {
        cwd: ".",
        model: "m",
        access: "ask",
        mcpServers: {
          cerium: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
          tools: { type: "stdio", command: "node", args: ["s.js"] },
        },
        includeUserMcpServers: false,
        trustedMcpServers: ["cerium"],
      },
      { mcpServers: ["node_repl", "cerium"] },
      "low",
    );
    expect(config).toEqual({
      agents: { enabled: false },
      features: { multi_agent: false, multi_agent_v2: false, apps: false, plugins: false },
      mcp_servers: {
        node_repl: { enabled: false },
        cerium: {
          url: "http://127.0.0.1:1/mcp",
          http_headers: { Authorization: "Bearer t" },
          default_tools_approval_mode: "approve",
        },
        tools: { command: "node", args: ["s.js"], default_tools_approval_mode: "prompt" },
      },
      model_reasoning_effort: "low",
    });
  });
});

describe("Server requests", () => {
  const translator = startedTranslator();
  const ctx = context(translator);
  const request = (method: string, params: object) => ({ id: 7, method, params }) as unknown as ServerRequest;

  it("approves a command for the session only when Codex offers it", () => {
    const params = {
      kind: "command",
      itemId: "c1",
      command: "pwsh -Command 'New-Item x'",
      commandActions: [{ type: "unknown", command: "New-Item x" }],
      cwd: WORKSPACE,
      reason: "Needs to write",
      availableDecisions: ["accept", "cancel"],
    };
    const ask = handleServerRequest(request("item/commandExecution/requestApproval", params), ctx);
    if (ask._tag !== "Ask") throw new Error("expected an approval prompt");
    expect(ask.summary).toBe("Run New-Item x (Needs to write)");
    expect(ask.reply({ decision: "allow", scope: "session" })).toEqual({ decision: "accept" });
    expect(ask.reply({ decision: "deny", scope: "once" })).toEqual({ decision: "decline" });
  });

  it("asks before untrusted MCP tools, runs trusted ones and declines data forms", () => {
    const running = startedTranslator();
    running.translate(
      notification("item/started", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "mcpToolCall",
          id: "m1",
          server: "other",
          tool: "ping",
          status: "inProgress",
          arguments: {},
        },
      }),
    );
    const approval = (serverName: string) =>
      request("mcpServer/elicitation/request", {
        serverName,
        mode: "form",
        message: `Allow the ${serverName} MCP server to run tool "ping"?`,
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
      });
    const ask = handleServerRequest(approval("other"), context(running));
    if (ask._tag !== "Ask") throw new Error("expected an approval prompt");
    expect(ask.toolName).toBe("mcp__other__ping");
    expect(ask.reply({ decision: "allow", scope: "session" })).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    });
    expect(handleServerRequest(approval("cerium"), context(running))).toEqual({
      _tag: "Reply",
      result: { action: "accept", content: null, _meta: null },
    });
    const form = request("mcpServer/elicitation/request", {
      serverName: "other",
      mode: "form",
      message: "Your name?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      _meta: null,
    });
    expect(handleServerRequest(form, ctx)).toEqual({
      _tag: "Reply",
      result: { action: "decline", content: null, _meta: null },
    });
  });

  it("answers requests Cerium cannot serve so the turn never waits", () => {
    expect(handleServerRequest(request("item/tool/requestUserInput", { questions: [] }), ctx)).toEqual({
      _tag: "Reply",
      result: { answers: {} },
    });
    expect(handleServerRequest(request("account/chatgptAuthTokens/refresh", {}), ctx)._tag).toBe("Fail");
    expect(handleServerRequest(request("something/new", {}), ctx)).toMatchObject({
      _tag: "Fail",
      code: -32601,
    });
  });
});
