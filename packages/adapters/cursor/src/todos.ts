import type { EventPayload, TodoItem } from "@cerium/protocol";
import { sameTodos } from "@cerium/protocol";

/** Cursor's todo tools: `updateTodos` writes the list, `readTodos` reads it back. */
const TODO_TOOLS: ReadonlySet<string> = new Set(["updateTodos", "readTodos"]);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const STATUSES: Readonly<Record<string, TodoItem["status"]>> = {
  inProgress: "inProgress",
  completed: "completed",
  cancelled: "cancelled",
};

const itemsOf = (todos: unknown): ReadonlyArray<TodoItem> | undefined =>
  Array.isArray(todos)
    ? todos.flatMap((each): ReadonlyArray<TodoItem> => {
        const content = field(each, "content");
        const status = field(each, "status");
        return typeof content === "string" && content !== ""
          ? [
              {
                text: content,
                status: (typeof status === "string" ? STATUSES[status] : undefined) ?? "pending",
              },
            ]
          : [];
      })
    : undefined;

/**
 * Cursor's todo list. `updateTodos` may merge: its arguments hold only the items it changes, while its
 * result holds the whole list, which is what is reported. The calls are bookkeeping, not tool calls, and
 * are not reported as such unless one fails.
 */
export class CursorTodos {
  #reported: ReadonlyArray<TodoItem> = [];

  isTodoTool(name: string): boolean {
    return TODO_TOOLS.has(name);
  }

  /** The events a finished todo call makes. */
  completed(callId: string, name: string, input: unknown, toolCall: unknown): ReadonlyArray<EventPayload> {
    const result = field(toolCall, "result");
    if (field(result, "status") === "error") {
      return [
        { _tag: "ToolCallStarted", callId, toolName: name, input },
        { _tag: "ToolCallCompleted", callId, output: field(result, "error"), isError: true },
      ];
    }
    const items = itemsOf(field(field(result, "value"), "todos"));
    if (items === undefined || sameTodos(this.#reported, items)) return [];
    this.#reported = items;
    return [{ _tag: "TodosUpdated", items }];
  }
}
