import { useSyncExternalStore } from "react";

// Something dragged toward the main area to open beside, or in place of, one of its panes: a tab, a
// sidebar row or a pane's own header. Whatever starts the drag reports the pointer here; the main area
// shows where it would land and takes the drop.

export type DragSource =
  | { readonly kind: "thread"; readonly key: string }
  | { readonly kind: "pane"; readonly id: string };

export interface PaneDrag {
  readonly source: DragSource;
  readonly x: number;
  readonly y: number;
}

/** The type a sidebar row's native drag carries its thread's key as. */
export const THREAD_DRAG_TYPE = "application/x-cerium-thread";

let current: PaneDrag | undefined;
let target: ((drag: PaneDrag) => void) | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export const paneDrag = {
  begin(source: DragSource, x: number, y: number) {
    current = { source, x, y };
    emit();
  },
  move(x: number, y: number) {
    if (current === undefined || (current.x === x && current.y === y)) return;
    current = { ...current, x, y };
    emit();
  },
  /** Lets go where the pointer is now: the main area takes it there. */
  drop(x: number, y: number) {
    const dropped = current === undefined ? undefined : { ...current, x, y };
    current = undefined;
    emit();
    if (dropped) target?.(dropped);
  },
  cancel() {
    if (current === undefined) return;
    current = undefined;
    emit();
  },
  active: () => current !== undefined,
  /** The main area, which takes drops; one at a time. */
  setTarget(onDrop: ((drag: PaneDrag) => void) | undefined) {
    target = onDrop;
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The drag under way, if any. */
export const usePaneDrag = () => useSyncExternalStore(subscribe, () => current);
