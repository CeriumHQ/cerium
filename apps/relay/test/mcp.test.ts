import type { AssistantRequest, AssistantResult, DeviceId, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  handleMcp,
  pickComputer,
  threadMessages,
  threadSummary,
  TOOLS,
  type AssistantDesk,
  type Computer,
  type ThreadSummary,
} from "../src/mcp.ts";

const computer = (name: string, extra: Partial<Computer> = {}): Computer => ({
  id: name.toLowerCase() as DeviceId,
  name,
  online: true,
  takesAssistants: true,
  ...extra,
});

const thread = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  machine: "laptop" as DeviceId,
  threadId: id as ThreadId,
  title: `Thread ${id}`,
  status: "idle",
  lastActiveAt: 1,
  ...extra,
});

const desk = (
  options: {
    computers?: ReadonlyArray<Computer>;
    threads?: ReadonlyArray<ThreadSummary>;
    answer?: (request: AssistantRequest) => AssistantResult;
  } = {},
) => {
  const calls: Array<{ computer: string; request: AssistantRequest }> = [];
  const value: AssistantDesk = {
    computers: () => options.computers ?? [computer("Laptop")],
    threads: () => options.threads ?? [],
    messages: () => [{ from: "lead", text: "Done.", at: 0 }],
    call: async (target, request) => {
      calls.push({ computer: target.name, request });
      return (
        options.answer?.(request) ?? { _tag: "ThreadStarted", threadId: "thr_new" as ThreadId, title: "New" }
      );
    },
  };
  return { desk: value, calls };
};

const rpc = (method: string, params?: unknown, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const notification = (method: string) => ({ jsonrpc: "2.0", method });

const call = async (target: AssistantDesk, name: string, args: unknown) => {
  const answer = (await handleMcp(rpc("tools/call", { name, arguments: args }), target)) as {
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  };
  return answer.result;
};

describe("the MCP endpoint", () => {
  it("agrees on a protocol version it speaks, and offers tools", async () => {
    const { desk: target } = desk();
    expect(await handleMcp(rpc("initialize", { protocolVersion: "2025-06-18" }), target)).toMatchObject({
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cerium" } },
    });
    expect(await handleMcp(rpc("initialize", { protocolVersion: "1999-01-01" }), target)).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });
    const listed = (await handleMcp(rpc("tools/list"), target)) as { result: { tools: typeof TOOLS } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain("create_thread");
  });

  it("answers nothing for notifications, and errors for unknown methods", async () => {
    const { desk: target } = desk();
    expect(await handleMcp(notification("notifications/initialized"), target)).toBeUndefined();
    expect(await handleMcp([notification("notifications/initialized")], target)).toBeUndefined();
    expect(await handleMcp(rpc("sampling/createMessage"), target)).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcp({ hello: "there" }, target)).toMatchObject({ error: { code: -32600 } });
  });

  it("answers a batch with one answer per request", async () => {
    const { desk: target } = desk();
    const answers = await handleMcp([rpc("ping", undefined, 1), rpc("ping", undefined, 2)], target);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });
});

describe("create_thread", () => {
  it("asks the computer that takes assistants to start the thread", async () => {
    const { desk: target, calls } = desk({
      computers: [computer("Laptop"), computer("Desk", { takesAssistants: false })],
    });
    const result = await call(target, "create_thread", {
      prompt: "Add dark mode to the settings page",
      project: "cerium",
      worktree: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ computer: "Laptop", threadId: "thr_new" });
    expect(calls).toEqual([
      {
        computer: "Laptop",
        request: {
          _tag: "StartThread",
          prompt: "Add dark mode to the settings page",
          project: "cerium",
          worktree: true,
        },
      },
    ]);
  });

  it("passes on the computer's refusal as an error", async () => {
    const { desk: target } = desk({
      answer: () => ({ _tag: "Refused", message: 'No project here is "x".' }),
    });
    const result = await call(target, "create_thread", { prompt: "Do it", project: "x" });
    expect(result).toMatchObject({ isError: true, content: [{ text: 'No project here is "x".' }] });
  });

  it("refuses arguments it doesn't take, and an empty prompt", async () => {
    const { desk: target, calls } = desk();
    expect((await call(target, "create_thread", { prompt: 42 })).isError).toBe(true);
    expect((await call(target, "create_thread", { prompt: "" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("picking a computer", () => {
  it("takes the only one that takes assistants", () => {
    expect(pickComputer([computer("A"), computer("B", { takesAssistants: false })], undefined)).toMatchObject(
      {
        name: "A",
      },
    );
  });

  it("asks which when several do", () => {
    expect(pickComputer([computer("A"), computer("B")], undefined)).toMatch(/Several computers/);
    expect(pickComputer([computer("A"), computer("B")], "b")).toMatchObject({ name: "B" });
  });

  it("says why none can", () => {
    expect(pickComputer([], undefined)).toMatch(/no computers/);
    expect(pickComputer([computer("A", { online: false, takesAssistants: false })], undefined)).toMatch(
      /isn't online|is online/,
    );
    expect(pickComputer([computer("A", { takesAssistants: false })], undefined)).toMatch(
      /Settings → Assistants/,
    );
    expect(pickComputer([computer("A", { online: false, takesAssistants: false })], "A")).toMatch(
      /isn't online/,
    );
    expect(pickComputer([computer("A")], "Z")).toMatch(/No computer is called/);
  });
});

describe("threads", () => {
  it("lists the latest first, filtered by the query", async () => {
    const { desk: target } = desk({
      threads: [
        thread("1", { title: "Fix login", lastActiveAt: 10 }),
        thread("2", { title: "Dark mode", lastActiveAt: 30, status: "working" }),
        thread("3", { title: "Fix logout", lastActiveAt: 20 }),
      ],
    });
    const all = await call(target, "list_threads", {});
    expect(
      ((all.structuredContent?.threads ?? []) as Array<{ threadId: string }>).map((each) => each.threadId),
    ).toEqual(["2", "3", "1"]);
    const fixes = await call(target, "list_threads", { query: "fix", limit: 1 });
    expect(fixes.structuredContent?.threads).toMatchObject([{ threadId: "3", computer: "Laptop" }]);
  });

  it("sends a message to the computer the thread lives on", async () => {
    const { desk: target, calls } = desk({ threads: [thread("thr_1")], answer: () => ({ _tag: "Sent" }) });
    const result = await call(target, "send_message", { thread_id: "thr_1", text: "Also add tests" });
    expect(result.structuredContent).toEqual({ computer: "Laptop", sent: true });
    expect(calls[0]?.request).toEqual({ _tag: "SendToThread", threadId: "thr_1", text: "Also add tests" });
    expect((await call(target, "send_message", { thread_id: "nope", text: "Hi" })).isError).toBe(true);
  });

  it("reads a thread's latest messages from the cloud copy", async () => {
    const { desk: target } = desk({ threads: [thread("thr_1", { status: "working" })] });
    const result = await call(target, "read_thread", { thread_id: "thr_1" });
    expect(result.structuredContent).toMatchObject({
      status: "working",
      messages: [{ from: "lead", text: "Done." }],
    });
  });
});

describe("the cloud copy, read", () => {
  const overview = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      thread: { id: "thr_1", title: "Dark mode", cwd: "/code/cerium", updatedAt: 5 },
      agents: [
        { id: "lead", state: "idle", updatedAt: 9 },
        { id: "child", parentId: "lead", state: "running", updatedAt: 7 },
      ],
      awaitingApproval: false,
      ...extra,
    });

  it("summarises a thread, its status from its agents", () => {
    expect(threadSummary("laptop" as DeviceId, overview())).toEqual({
      machine: "laptop",
      threadId: "thr_1",
      title: "Dark mode",
      project: "/code/cerium",
      status: "working",
      lastActiveAt: 9,
    });
    expect(threadSummary("laptop" as DeviceId, overview({ awaitingApproval: true }))?.status).toBe(
      "waiting on the user",
    );
  });

  it("leaves out archived threads and what it can't read", () => {
    expect(
      threadSummary("laptop" as DeviceId, overview({ thread: { id: "thr_1", archivedAt: 3 } })),
    ).toBeUndefined();
    expect(threadSummary("laptop" as DeviceId, "{not json")).toBeUndefined();
  });

  it("keeps the user's messages and the lead's replies, not its children's", () => {
    const events = [
      {
        agentId: "lead",
        at: 1,
        payload: { _tag: "MessageQueued", message: { _tag: "FromUser", text: "Add dark mode" } },
      },
      { agentId: "child", at: 2, payload: { _tag: "MessageCompleted", text: "Child chatter" } },
      { agentId: "lead", at: 3, payload: { _tag: "ToolCallStarted" } },
      { agentId: "lead", at: 4, payload: { _tag: "MessageCompleted", text: "Dark mode is in." } },
      {
        agentId: "lead",
        at: 5,
        payload: { _tag: "MessageQueued", message: { _tag: "FromUser", id: "msg_2", text: "Add tests" } },
      },
      {
        agentId: "lead",
        at: 6,
        payload: {
          _tag: "TurnInput",
          items: [
            { _tag: "FromUser", id: "msg_2", text: "Add tests" },
            { _tag: "SystemNotice", text: "A notice" },
          ],
        },
      },
      {
        agentId: "lead",
        at: 7,
        payload: { _tag: "TurnInput", items: [{ _tag: "FromUser", id: "msg_3", text: "And docs" }] },
      },
    ];
    expect(threadMessages(overview(), events)).toEqual([
      { from: "user", text: "Add dark mode", at: 1 },
      { from: "lead", text: "Dark mode is in.", at: 4 },
      { from: "user", text: "Add tests", at: 5 },
      { from: "user", text: "And docs", at: 7 },
    ]);
  });
});
