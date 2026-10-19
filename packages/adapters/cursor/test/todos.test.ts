import { EventPayload, type EventPayload as Payload, type TodoItem } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CursorTranslator, type CursorRecord } from "../src/translate.ts";

const fixture = (name: string): ReadonlyArray<CursorRecord> =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CursorRecord);

const translateAll = (records: ReadonlyArray<CursorRecord>) => {
  const translator = new CursorTranslator();
  return records.flatMap((record) => translator.translate(record));
};

const lists = (payloads: ReadonlyArray<Payload>) =>
  payloads.flatMap((payload) => (payload._tag === "TodosUpdated" ? [payload.items] : []));

const compact = (items: ReadonlyArray<TodoItem>) => items.map((each) => `${each.status}:${each.text}`);

const LIST = "List the working directory with a command";
const DONE = "Reply with DONE";

describe("CursorTranslator on a recorded session keeping a todo list", () => {
  const events = translateAll(fixture("todo-session.jsonl"));
  const payloads = events.map((event) => event.payload);

  it("emits only payloads that satisfy the canonical schema", () => {
    for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
  });

  it("reports the whole list at every change", () => {
    expect(lists(payloads).map(compact)).toEqual([
      [`pending:${LIST}`, `pending:${DONE}`],
      [`inProgress:${LIST}`, `pending:${DONE}`],
      [`completed:${LIST}`, `inProgress:${DONE}`],
      // The last call wrote one item; its result held both.
      [`completed:${LIST}`, `completed:${DONE}`],
    ]);
  });

  it("does not report the todo calls as tool calls", () => {
    const tools = payloads.flatMap((payload) =>
      payload._tag === "ToolCallStarted" ? [payload.toolName] : [],
    );
    expect(tools).toEqual(["glob"]);
  });

  it("keeps the raw update on the event", () => {
    const update = events.find((event) => event.payload._tag === "TodosUpdated");
    expect(update?.raw).toMatchObject({ type: "tool-call-completed" });
  });
});

describe("Cursor's todo tools", () => {
  const update = (type: "tool-call-started" | "tool-call-completed", callId: string, toolCall: object) =>
    ({ type: "update", turn: "t1", update: { type, callId, toolCall } }) as unknown as CursorRecord;
  const todo = (content: string, status: string) => ({ content, status });

  it("takes the list from the result, and tells a merge from a rewrite", () => {
    const payloads = translateAll([
      update("tool-call-completed", "c1", {
        type: "updateTodos",
        args: { todos: [todo("One", "pending"), todo("Two", "pending")] },
        result: {
          status: "success",
          value: { todos: [todo("One", "pending"), todo("Two", "pending")], totalCount: 2 },
        },
      }),
      update("tool-call-completed", "c2", {
        type: "updateTodos",
        args: { todos: [todo("Two", "cancelled")] },
        result: {
          status: "success",
          value: { todos: [todo("One", "pending"), todo("Two", "cancelled")], totalCount: 2 },
        },
      }),
    ]).map((event) => event.payload);
    expect(lists(payloads).map(compact)).toEqual([
      ["pending:One", "pending:Two"],
      ["pending:One", "cancelled:Two"],
    ]);
  });

  it("leaves out a call that changes nothing, and one that reported no list", () => {
    const same = {
      type: "updateTodos",
      args: { todos: [todo("One", "pending")] },
      result: { status: "success", value: { todos: [todo("One", "pending")], totalCount: 1 } },
    };
    const payloads = translateAll([
      update("tool-call-completed", "c1", same),
      update("tool-call-completed", "c2", same),
      update("tool-call-completed", "c3", { type: "updateTodos", args: { todos: [todo("Two", "pending")] } }),
    ]).map((event) => event.payload);
    expect(lists(payloads).map(compact)).toEqual([["pending:One"]]);
  });

  it("reports a todo call that failed as the failed tool call it is", () => {
    const payloads = translateAll([
      update("tool-call-completed", "c1", {
        type: "updateTodos",
        args: { todos: [todo("One", "pending")] },
        result: { status: "error", error: "Could not save the list" },
      }),
    ]).map((event) => event.payload);
    expect(payloads).toEqual([
      {
        _tag: "ToolCallStarted",
        callId: "c1",
        toolName: "updateTodos",
        input: { todos: [todo("One", "pending")] },
      },
      { _tag: "ToolCallCompleted", callId: "c1", output: "Could not save the list", isError: true },
    ]);
  });

  it("reads a status it doesn't know as pending", () => {
    const payloads = translateAll([
      update("tool-call-completed", "c1", {
        type: "updateTodos",
        args: { todos: [] },
        result: { status: "success", value: { todos: [todo("One", "blocked")], totalCount: 1 } },
      }),
    ]).map((event) => event.payload);
    expect(lists(payloads).map(compact)).toEqual([["pending:One"]]);
  });
});
