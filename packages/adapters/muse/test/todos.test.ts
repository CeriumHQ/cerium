import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload, TodoItem } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RecordedFrame } from "../src/session.ts";
import { MuseTranslator, type WireNotification } from "../src/translate.ts";

const fixture = (name: string): ReadonlyArray<RecordedFrame> =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RecordedFrame);

const replay = (frames: ReadonlyArray<RecordedFrame>): ReadonlyArray<AdapterEvent> => {
  const translator = new MuseTranslator({ workspace: "<workspace>" });
  return frames.flatMap((frame): ReadonlyArray<AdapterEvent> => {
    if (!("cerium" in frame)) return translator.translate(frame);
    if (frame.cerium === "expectTurn") translator.expectTurn(frame.turnId);
    else translator.renameTurn(frame.from, frame.to);
    return [];
  });
};

const lists = (payloads: ReadonlyArray<EventPayload>) =>
  payloads.flatMap((payload) => (payload._tag === "TodosUpdated" ? [payload.items] : []));

const compact = (items: ReadonlyArray<TodoItem>) => items.map((each) => `${each.status}:${each.text}`);

const LIST = "List the working directory with a command";
const DONE = "Reply with DONE";

describe("MuseTranslator on a recorded session keeping a todo list", () => {
  const events = replay(fixture("todo-session.jsonl"));
  const payloads = events.map((event) => event.payload);

  it("reports the whole list at every change", () => {
    expect(lists(payloads).map(compact)).toEqual([
      [`pending:${LIST}`, `pending:${DONE}`],
      [`inProgress:${LIST}`, `pending:${DONE}`],
      [`cancelled:${LIST}`, `inProgress:${DONE}`],
      [`cancelled:${LIST}`, `completed:${DONE}`],
    ]);
  });

  it("does not report the todo tool's calls as tool calls", () => {
    const tools = payloads.flatMap((payload) =>
      payload._tag === "ToolCallStarted" ? [payload.toolName] : [],
    );
    expect(tools).toEqual(["powershell"]);
  });

  it("keeps the raw notification on the event", () => {
    const update = events.find((event) => event.payload._tag === "TodosUpdated");
    expect(update?.raw).toMatchObject({ method: "session/todoListChanged" });
  });
});

describe("Muse's todo list", () => {
  const changed = (items: ReadonlyArray<object>): WireNotification => ({
    method: "session/todoListChanged",
    params: { sessionId: "s1", revision: 1, sourceTool: "write_todos", items },
  });
  const run = (...notifications: ReadonlyArray<WireNotification>) => {
    const translator = new MuseTranslator({ workspace: "<workspace>" });
    return notifications.flatMap((each) => translator.translate(each)).map((event) => event.payload);
  };

  it("keeps the present-tense form and reads a status it doesn't know as pending", () => {
    const payloads = run(
      changed([
        { text: "Run the tests", status: "inProgress", activeForm: "Running the tests" },
        { text: "Ship", status: "someday" },
      ]),
    );
    expect(lists(payloads)).toEqual([
      [
        { text: "Run the tests", status: "inProgress", activeText: "Running the tests" },
        { text: "Ship", status: "pending" },
      ],
    ]);
  });

  it("leaves out a list that changes nothing, and reports an emptied one", () => {
    const one = changed([{ text: "One", status: "pending" }]);
    expect(lists(run(one, one, changed([]))).map(compact)).toEqual([["pending:One"], []]);
  });

  it("reports a todo call that failed as the failed tool call it is", () => {
    const call = (status: string) => ({
      itemId: "i1",
      kind: "toolCall",
      tool: "write_todos",
      status,
      args: '{"todos":[]}',
      failureReason: "tool failed",
    });
    const item = (method: string, status: string): WireNotification => ({
      method,
      params: { sessionId: "s1", item: call(status) },
    });
    expect(run(item("item/started", "inProgress"), item("item/completed", "failed"))).toEqual([
      { _tag: "ToolCallStarted", callId: "i1", toolName: "write_todos", input: { todos: [] } },
      { _tag: "ToolCallCompleted", callId: "i1", output: "tool failed", isError: true },
    ]);
  });
});
