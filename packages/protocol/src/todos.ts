import type { TodoItem } from "./events.ts";

/**
 * Whether two todo lists read the same. Adapters leave out an update that changes nothing, which
 * harnesses send as often as they re-send the list.
 */
export const sameTodos = (a: ReadonlyArray<TodoItem>, b: ReadonlyArray<TodoItem>): boolean =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      item.id === other.id &&
      item.text === other.text &&
      item.status === other.status &&
      item.activeText === other.activeText
    );
  });
