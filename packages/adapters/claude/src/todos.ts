import type { EventPayload, TodoItem } from "@cerium/protocol";
import { sameTodos } from "@cerium/protocol";

import { TODO_TOOLS } from "./manifest.ts";

type Status = TodoItem["status"];

const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(TODO_TOOLS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Task ids are strings in Claude Code's output and input, but a number must not drop a task. */
const idOf = (value: unknown): string | undefined =>
  typeof value === "number" ? String(value) : text(value);

const statusOf = (value: unknown): Status => {
  switch (value) {
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    default:
      return "pending";
  }
};

const item = (fields: {
  readonly id?: string | undefined;
  readonly text: string;
  readonly status: Status;
  readonly activeText?: string | undefined;
}): TodoItem => ({
  ...(fields.id === undefined ? {} : { id: fields.id }),
  text: fields.text,
  status: fields.status,
  ...(fields.activeText === undefined ? {} : { activeText: fields.activeText }),
});

/** `TodoWrite`'s list: it names each item's text `content` and its present-tense form `activeForm`. */
const fromTodoWrite = (todos: unknown): ReadonlyArray<TodoItem> | undefined =>
  Array.isArray(todos)
    ? todos.flatMap((each) =>
        isRecord(each) && text(each["content"]) !== undefined
          ? [
              item({
                text: each["content"] as string,
                status: statusOf(each["status"]),
                activeText: text(each["activeForm"]),
              }),
            ]
          : [],
      )
    : undefined;

/** A tool call whose result is still to come. */
interface Call {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Claude Code's todo list. Models it knows keep one with `TodoWrite` (the whole list at every call) or,
 * in current versions, the Task tools, which change one task at a time: `TaskCreate` learns the task's
 * id only from its result, `TaskUpdate` changes one by id, `TaskList` and `TaskGet` read them back. The
 * translator keeps the tasks, so every change becomes the whole list. The calls themselves are
 * bookkeeping, not tool calls, and are not reported as such unless one fails.
 */
export class ClaudeTodos {
  readonly #calls = new Map<string, Call>();
  /** The Task tools' tasks by id, in the order they were made. */
  readonly #tasks = new Map<string, TodoItem>();
  #reported: ReadonlyArray<TodoItem> = [];

  /** Takes a todo tool call; false for any other tool, which the caller reports as a tool call. */
  call(callId: string, name: string, input: unknown): boolean {
    if (!TODO_TOOL_NAMES.has(name)) return false;
    this.#calls.set(callId, { name, input });
    return true;
  }

  /** The events a todo tool call's result makes; undefined when the result is not of a todo tool call. */
  result(
    callId: string,
    block: { readonly is_error?: boolean | undefined; readonly content?: unknown },
    structured: unknown,
  ): ReadonlyArray<EventPayload> | undefined {
    const call = this.#calls.get(callId);
    if (call === undefined) return undefined;
    this.#calls.delete(callId);
    if (block.is_error === true) {
      return [
        { _tag: "ToolCallStarted", callId, toolName: call.name, input: call.input },
        { _tag: "ToolCallCompleted", callId, output: block.content, isError: true },
      ];
    }
    const result = isRecord(structured) ? structured : {};
    const changed = this.#apply(call, result, typeof block.content === "string" ? block.content : "");
    if (!changed || sameTodos(this.#reported, changed)) return [];
    this.#reported = changed;
    return [{ _tag: "TodosUpdated", items: changed }];
  }

  /** The list after the call, or undefined when the call leaves it as it was. */
  #apply(call: Call, result: Record<string, unknown>, said: string): ReadonlyArray<TodoItem> | undefined {
    const input = isRecord(call.input) ? call.input : {};
    switch (call.name) {
      case "TodoWrite":
        return fromTodoWrite(result["newTodos"]) ?? fromTodoWrite(input["todos"]);
      case "TaskCreate": {
        const made = isRecord(result["task"]) ? result["task"] : {};
        const id = idOf(made["id"]) ?? /Task #(\d+)/.exec(said)?.[1];
        const subject = text(input["subject"]) ?? text(made["subject"]);
        if (id === undefined || subject === undefined) return undefined;
        this.#tasks.set(
          id,
          item({ id, text: subject, status: "pending", activeText: text(input["activeForm"]) }),
        );
        return [...this.#tasks.values()];
      }
      case "TaskUpdate": {
        if (result["success"] === false) return undefined;
        const id = idOf(input["taskId"]) ?? idOf(input["id"]) ?? idOf(input["task_id"]);
        if (id === undefined) return undefined;
        if (input["status"] === "deleted") {
          return this.#tasks.delete(id) ? [...this.#tasks.values()] : undefined;
        }
        const task = this.#tasks.get(id);
        if (task === undefined) return undefined;
        this.#tasks.set(
          id,
          item({
            id,
            text: text(input["subject"]) ?? task.text,
            status: input["status"] === undefined ? task.status : statusOf(input["status"]),
            activeText: text(input["activeForm"]) ?? task.activeText,
          }),
        );
        return [...this.#tasks.values()];
      }
      case "TaskList": {
        const listed = result["tasks"];
        if (!Array.isArray(listed)) return undefined;
        const before = new Map(this.#tasks);
        this.#tasks.clear();
        for (const each of listed) {
          const id = isRecord(each) ? idOf(each["id"]) : undefined;
          const subject = isRecord(each) ? text(each["subject"]) : undefined;
          if (id === undefined || subject === undefined) continue;
          // A listing leaves out the present-tense form, which the call that made the task gave.
          this.#tasks.set(
            id,
            item({
              id,
              text: subject,
              status: statusOf((each as Record<string, unknown>)["status"]),
              activeText: before.get(id)?.activeText,
            }),
          );
        }
        return [...this.#tasks.values()];
      }
      case "TaskGet": {
        const found = isRecord(result["task"]) ? result["task"] : undefined;
        const id = found === undefined ? undefined : idOf(found["id"]);
        const subject = found === undefined ? undefined : text(found["subject"]);
        if (found === undefined || id === undefined || subject === undefined) return undefined;
        this.#tasks.set(
          id,
          item({
            id,
            text: subject,
            status: statusOf(found["status"]),
            activeText: this.#tasks.get(id)?.activeText,
          }),
        );
        return [...this.#tasks.values()];
      }
      default:
        return undefined;
    }
  }
}
