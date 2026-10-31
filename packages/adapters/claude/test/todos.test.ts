import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventPayload, TodoItem } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ClaudeTranslator } from "../src/translate.ts";

const fixture = (name: string): ReadonlyArray<SDKMessage> =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage | { type: "cerium_permission_request" })
    .filter((message): message is SDKMessage => message.type !== "cerium_permission_request");

const translateAll = (messages: ReadonlyArray<SDKMessage>) => {
  const translator = new ClaudeTranslator();
  return messages.flatMap((message) => translator.translate(message));
};

const lists = (payloads: ReadonlyArray<EventPayload>) =>
  payloads.flatMap((payload) => (payload._tag === "TodosUpdated" ? [payload.items] : []));

const compact = (items: ReadonlyArray<TodoItem>) => items.map((each) => `${each.status}:${each.text}`);

const A = "Create a.txt containing the text a";
const B = "Create b.txt containing the text b";

describe("ClaudeTranslator on a recorded session using the Task tools", () => {
  const events = translateAll(fixture("todo-session.jsonl"));
  const payloads = events.map((event) => event.payload);

  it("reports the whole list at every change", () => {
    expect(lists(payloads).map(compact)).toEqual([
      [`pending:${A}`],
      [`pending:${A}`, `pending:${B}`],
      [`inProgress:${A}`, `pending:${B}`],
      [`completed:${A}`, `pending:${B}`],
      [`completed:${A}`, `inProgress:${B}`],
      [`completed:${A}`, `completed:${B}`],
    ]);
  });

  it("keeps each task's id and present-tense form", () => {
    expect(lists(payloads).at(-1)).toEqual([
      { id: "1", text: A, status: "completed", activeText: "Creating a.txt" },
      { id: "2", text: B, status: "completed", activeText: "Creating b.txt" },
    ]);
  });

  it("does not report the bookkeeping calls as tool calls", () => {
    const tools = payloads.flatMap((payload) =>
      payload._tag === "ToolCallStarted" ? [payload.toolName] : [],
    );
    expect(tools).toEqual(["ToolSearch", "Write", "Write"]);
    const started = payloads.filter((payload) => payload._tag === "ToolCallStarted").length;
    expect(payloads.filter((payload) => payload._tag === "ToolCallCompleted")).toHaveLength(started);
  });
});

describe("ClaudeTranslator on a recorded session using TodoWrite", () => {
  const payloads = translateAll(fixture("todo-write-session.jsonl")).map((event) => event.payload);

  it("reports each list TodoWrite wrote", () => {
    expect(lists(payloads).map(compact)).toEqual([
      [`inProgress:${A}`, `pending:${B}`],
      [`completed:${A}`, `inProgress:${B}`],
      [`completed:${A}`, `completed:${B}`],
    ]);
    expect(lists(payloads)[0]?.[0]).toEqual({ text: A, status: "inProgress", activeText: "Creating a.txt" });
  });

  it("does not report TodoWrite as a tool call", () => {
    const tools = payloads.flatMap((payload) =>
      payload._tag === "ToolCallStarted" ? [payload.toolName] : [],
    );
    expect(tools).not.toContain("TodoWrite");
  });
});

describe("Claude Code's todo tools", () => {
  const use = (id: string, name: string, input: unknown) =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] },
    }) as unknown as SDKMessage;
  const result = (id: string, structured: unknown, content: unknown = "ok", isError = false) =>
    ({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
      tool_use_result: structured,
    }) as unknown as SDKMessage;
  const run = (messages: ReadonlyArray<SDKMessage>) => translateAll(messages).map((event) => event.payload);

  it("learns a created task's id from its result, or from the sentence that says it", () => {
    const payloads = run([
      use("t1", "TaskCreate", { subject: "One", description: "d" }),
      result("t1", { task: { id: "7", subject: "One" } }),
      use("t2", "TaskCreate", { subject: "Two", description: "d" }),
      result("t2", undefined, "Task #8 created successfully: Two"),
    ]);
    expect(lists(payloads).map((items) => items.map((each) => each.id))).toEqual([["7"], ["7", "8"]]);
  });

  it("removes a deleted task and leaves out an update that changes nothing", () => {
    const payloads = run([
      use("t1", "TaskCreate", { subject: "One", description: "d" }),
      result("t1", { task: { id: "1", subject: "One" } }),
      use("t2", "TaskUpdate", { taskId: "1", status: "pending" }),
      result("t2", { success: true, taskId: "1", updatedFields: [] }),
      use("t3", "TaskUpdate", { taskId: "1", status: "deleted" }),
      result("t3", { success: true, taskId: "1", updatedFields: ["status"] }),
    ]);
    expect(lists(payloads).map(compact)).toEqual([["pending:One"], []]);
  });

  it("changes nothing for a task it never heard of, or an update that failed", () => {
    const payloads = run([
      use("t1", "TaskUpdate", { taskId: "9", status: "completed" }),
      result("t1", { success: true, taskId: "9", updatedFields: ["status"] }),
      use("t2", "TaskCreate", { subject: "One", description: "d" }),
      result("t2", { task: { id: "1", subject: "One" } }),
      use("t3", "TaskUpdate", { taskId: "1", status: "completed" }),
      result("t3", { success: false, taskId: "1", updatedFields: [], error: "Blocked" }),
    ]);
    expect(lists(payloads).map(compact)).toEqual([["pending:One"]]);
  });

  it("takes the list a TaskList call reads back, keeping the forms the tasks were made with", () => {
    const payloads = run([
      use("t1", "TaskCreate", { subject: "One", description: "d", activeForm: "Doing one" }),
      result("t1", { task: { id: "1", subject: "One" } }),
      use("t2", "TaskList", {}),
      result("t2", {
        tasks: [
          { id: "1", subject: "One", status: "in_progress", blockedBy: [] },
          { id: "2", subject: "Two", status: "pending", blockedBy: ["1"] },
        ],
      }),
    ]);
    expect(lists(payloads).at(-1)).toEqual([
      { id: "1", text: "One", status: "inProgress", activeText: "Doing one" },
      { id: "2", text: "Two", status: "pending" },
    ]);
  });

  it("reports a todo call that failed as the failed tool call it is", () => {
    const payloads = run([
      use("t1", "TaskUpdate", { taskId: "1", status: "completed" }),
      result("t1", undefined, "No such task", true),
    ]);
    expect(payloads).toEqual([
      {
        _tag: "ToolCallStarted",
        callId: "t1",
        toolName: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
      },
      { _tag: "ToolCallCompleted", callId: "t1", output: "No such task", isError: true },
    ]);
  });

  it("clears the list when TodoWrite writes an empty one", () => {
    const write = (id: string, todos: ReadonlyArray<object>) => [
      use(id, "TodoWrite", { todos }),
      result(id, { oldTodos: [], newTodos: todos }),
    ];
    const one = { content: "One", status: "pending", activeForm: "Doing one" };
    const payloads = run([...write("t1", [one]), ...write("t2", [])]);
    expect(lists(payloads).map(compact)).toEqual([["pending:One"], []]);
  });
});
