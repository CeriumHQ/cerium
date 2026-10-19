import { Button } from "@base-ui/react/button";
import { Columns2, Rows2, X } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { paneDrag, THREAD_DRAG_TYPE, usePaneDrag, type DragSource, type PaneDrag } from "./drag.ts";
import {
  dropZoneAt,
  layoutOf,
  moveEdge,
  type Box,
  type DropZone,
  type Edge,
  type PaneLeaf,
  type Panes,
  type Side,
  type SplitPath,
} from "./model.ts";

/** The gap between panes, as between the window's other panels. */
const GAP = 6;
/** The least room a pane keeps as its neighbours grow. */
export const MIN_PANE = { width: 340, height: 220 } as const;
/** How far a pane's header travels under the pointer before pressing it becomes dragging the pane. */
const DRAG_THRESHOLD = 4;
const EPSILON = 0.0001;

/** What a pane's header says of what it shows. */
export interface PaneLabel {
  readonly title: string;
  /** Leads the title: the thread's status or harness, or the file's icon. */
  readonly icon?: ReactNode;
  /** Where it is, such as the thread's project. */
  readonly detail?: string;
}

/** `box` as CSS, inset by half the gap on each side another pane shares. */
const placed = (box: Box) => {
  const start = box.x > EPSILON ? GAP / 2 : 0;
  const end = box.x + box.width < 1 - EPSILON ? GAP / 2 : 0;
  const top = box.y > EPSILON ? GAP / 2 : 0;
  const bottom = box.y + box.height < 1 - EPSILON ? GAP / 2 : 0;
  return {
    left: `calc(${box.x * 100}% + ${start}px)`,
    top: `calc(${box.y * 100}% + ${top}px)`,
    width: `calc(${box.width * 100}% - ${start + end}px)`,
    height: `calc(${box.height * 100}% - ${top + bottom}px)`,
  };
};

/** The part of `box` a drop on `zone` takes. */
const zoneBox = (box: Box, zone: DropZone): Box => {
  switch (zone) {
    case "left":
      return { ...box, width: box.width / 2 };
    case "right":
      return { ...box, x: box.x + box.width / 2, width: box.width / 2 };
    case "top":
      return { ...box, height: box.height / 2 };
    case "bottom":
      return { ...box, y: box.y + box.height / 2, height: box.height / 2 };
    case "center":
      return box;
  }
};

/**
 * The main area as panes side by side and one above another, each its own card. Every pane stays
 * mounted wherever it moves, so a conversation keeps its scroll and its draft as the panes around it
 * open and close. With more than one pane, each wears a header to tell it apart, focus and drag it by;
 * the edges between them drag to share the room differently.
 */
export function SplitView({
  panes,
  renderPane,
  label,
  onFocus,
  onResize,
  onClose,
  onSplit,
  canDrop,
  onDrop,
}: {
  panes: Panes;
  renderPane: (leaf: PaneLeaf, focused: boolean) => ReactNode;
  label: (leaf: PaneLeaf) => PaneLabel;
  onFocus: (id: string) => void;
  onResize: (path: SplitPath, sizes: ReadonlyArray<number>) => void;
  onClose: (id: string) => void;
  /** Opens a new thread on `side` of the pane. */
  onSplit: (id: string, side: Side) => void;
  /** Whether `source` dropped on `zone` of the pane `target`, `size` in pixels, would change anything. */
  canDrop: (
    source: DragSource,
    target: string,
    zone: DropZone,
    size: { readonly width: number; readonly height: number },
  ) => boolean;
  onDrop: (source: DragSource, target: string, zone: DropZone) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const { panes: placedPanes, edges } = layoutOf(panes.root);
  const split = placedPanes.length > 1;
  const drag = usePaneDrag();
  /** An edge being dragged: the panes follow it at once rather than easing after it. */
  const [resizing, setResizing] = useState(false);

  /** Where the area is in the window, measured afresh as a drag starts and as the area resizes. */
  const [rect, setRect] = useState<DOMRect>();
  const dragging = drag !== undefined;
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => setRect(element.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [dragging]);

  /** Where a drag at the window's (`x`, `y`) would land: which pane, and where in it. */
  const landing = (x: number, y: number, source: DragSource) => {
    if (rect === undefined || rect.width === 0 || rect.height === 0) return undefined;
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    const hit = placedPanes.find(
      ({ box }) => fx >= box.x && fx < box.x + box.width && fy >= box.y && fy < box.y + box.height,
    );
    if (hit === undefined) return undefined;
    const zone = dropZoneAt(
      (fx - hit.box.x) * rect.width,
      (fy - hit.box.y) * rect.height,
      hit.box.width * rect.width,
      hit.box.height * rect.height,
    );
    const size = { width: hit.box.width * rect.width, height: hit.box.height * rect.height };
    return canDrop(source, hit.leaf.id, zone, size) ? { id: hit.leaf.id, zone, box: hit.box } : undefined;
  };

  // This is where drops land while it's mounted.
  const take = useEffectEvent((dropped: PaneDrag) => {
    const at = landing(dropped.x, dropped.y, dropped.source);
    if (at) onDrop(dropped.source, at.id, at.zone);
  });
  useEffect(() => {
    paneDrag.setTarget((dropped) => take(dropped));
    return () => paneDrag.setTarget(undefined);
  }, []);

  const hover = drag ? landing(drag.x, drag.y, drag.source) : undefined;

  // A sidebar row is dragged natively: its thread rides along under its own type.
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE) || !paneDrag.active()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    paneDrag.move(event.clientX, event.clientY);
  };
  const onNativeDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
    event.preventDefault();
    paneDrag.drop(event.clientX, event.clientY);
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={area} onDragOver={onDragOver} onDrop={onNativeDrop} className="relative h-full w-full">
      {placedPanes.map(({ leaf, box }) => {
        const focused = leaf.id === panes.focused;
        return (
          <section
            key={leaf.id}
            aria-label={split ? label(leaf).title : undefined}
            onPointerDownCapture={() => onFocus(leaf.id)}
            onFocusCapture={() => onFocus(leaf.id)}
            style={placed(box)}
            className={`absolute flex flex-col overflow-hidden rounded-xl border bg-surface-panel shadow-raised ${
              resizing || drag ? "" : "transition-[left,top,width,height] duration-200 ease-out-soft"
            } motion-reduce:transition-none ${
              split && focused ? "border-line-strong" : "border-line-subtle"
            }`}
          >
            {split ? (
              <PaneHeader
                id={leaf.id}
                label={label(leaf)}
                focused={focused}
                onClose={() => onClose(leaf.id)}
                onSplit={(side) => onSplit(leaf.id, side)}
              />
            ) : null}
            <div className="relative min-h-0 flex-1">{renderPane(leaf, focused)}</div>
          </section>
        );
      })}
      {edges.map((edge) => (
        <EdgeHandle
          key={`${edge.path.join(".")}:${edge.index}`}
          edge={edge}
          area={area}
          onResize={onResize}
          onDragChange={setResizing}
        />
      ))}
      {hover ? (
        <div
          aria-hidden
          style={placed(zoneBox(hover.box, hover.zone))}
          className="pointer-events-none absolute z-30 rounded-xl border border-focus-ring bg-accent-soft transition-[left,top,width,height] duration-150 ease-out-soft motion-reduce:transition-none"
        />
      ) : null}
    </div>
  );
}

/** A pane's name, which it's focused, dragged and closed by while it shares the area with others. */
function PaneHeader({
  id,
  label,
  focused,
  onClose,
  onSplit,
}: {
  id: string;
  label: PaneLabel;
  focused: boolean;
  onClose: () => void;
  onSplit: (side: Side) => void;
}) {
  const press = useRef<{ x: number; y: number; dragging: boolean }>(undefined);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    press.current = { x: event.clientX, y: event.clientY, dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (current === undefined) return;
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
      current.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      paneDrag.begin({ kind: "pane", id }, event.clientX, event.clientY);
    }
    paneDrag.move(event.clientX, event.clientY);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (press.current?.dragging) paneDrag.drop(event.clientX, event.clientY);
    press.current = undefined;
  };
  const onPointerCancel = () => {
    if (press.current?.dragging) paneDrag.cancel();
    press.current = undefined;
  };
  return (
    <ContextMenuArea
      menu={
        <>
          <MenuItem icon={Columns2} shortcut="Ctrl \" onClick={() => onSplit("right")}>
            New thread to the right
          </MenuItem>
          <MenuItem icon={Rows2} shortcut="Ctrl Shift \" onClick={() => onSplit("bottom")}>
            New thread below
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={X} onClick={onClose}>
            Close pane
          </MenuItem>
        </>
      }
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className={`group/pane flex h-8 shrink-0 cursor-default items-center gap-2 border-b border-line-subtle pr-1 pl-3 text-[12.5px] select-none ${
          focused ? "text-fg-primary" : "text-fg-tertiary"
        }`}
      >
        {label.icon ? (
          <span className={`grid size-3.5 shrink-0 place-items-center ${focused ? "" : "opacity-70"}`}>
            {label.icon}
          </span>
        ) : null}
        <span className="min-w-0 truncate">{label.title}</span>
        {label.detail ? (
          <span className="min-w-0 shrink-[2] truncate text-fg-tertiary">{label.detail}</span>
        ) : null}
        <Tooltip label="Close pane">
          <Button
            aria-label={`Close pane “${label.title}”`}
            onClick={onClose}
            className={`ml-auto grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-[opacity,background-color,color] duration-150 hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 ${
              focused ? "opacity-100" : "opacity-0 group-hover/pane:opacity-100"
            }`}
          >
            <X size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
      </header>
    </ContextMenuArea>
  );
}

/** What an arrow key moves an edge by, as a share of its split, and with Shift held. */
const STEP = 0.02;
const BIG_STEP = 0.08;

/** The gap between two panes, to drag (or nudge with the arrow keys) to share their room differently. */
function EdgeHandle({
  edge,
  area,
  onResize,
  onDragChange,
}: {
  edge: Edge;
  area: RefObject<HTMLDivElement | null>;
  onResize: (path: SplitPath, sizes: ReadonlyArray<number>) => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const row = edge.axis === "row";
  const [drag, setDrag] = useState<{
    readonly from: number;
    readonly length: number;
    readonly sizes: ReadonlyArray<number>;
  }>();
  /** The split's length along its axis, in pixels, and the least share each pane keeps of it. */
  const measure = () => {
    const rect = area.current?.getBoundingClientRect();
    const length = rect === undefined ? 0 : row ? rect.width * edge.box.width : rect.height * edge.box.height;
    return { length, min: length > 0 ? (row ? MIN_PANE.width : MIN_PANE.height) / length : 0 };
  };
  const nudge = (by: number) => {
    const { min } = measure();
    onResize(edge.path, moveEdge(edge.sizes, edge.index, by, min));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const back = row ? "ArrowLeft" : "ArrowUp";
    const forward = row ? "ArrowRight" : "ArrowDown";
    if (event.key === back) nudge(-step);
    else if (event.key === forward) nudge(step);
    else if (event.key === "Enter") evenOut();
    else return;
    event.preventDefault();
  };
  /** The two panes on the edge take half of their room each. */
  const evenOut = () => {
    const a = edge.sizes[edge.index] ?? 0;
    const b = edge.sizes[edge.index + 1] ?? 0;
    nudge((a + b) / 2 - a);
  };
  const before = edge.sizes.slice(0, edge.index + 1).reduce((sum, size) => sum + size, 0);
  return (
    <div
      // A splitter that takes focus and keys is a widget, which `hr` can't be.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "Resize panes side by side" : "Resize panes above and below"}
      aria-valuenow={Math.round(before * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-dragging={drag ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ from: row ? event.clientX : event.clientY, length: measure().length, sizes: edge.sizes });
        onDragChange(true);
      }}
      onPointerMove={(event) => {
        if (!drag || drag.length === 0) return;
        const moved = ((row ? event.clientX : event.clientY) - drag.from) / drag.length;
        const { min } = measure();
        onResize(edge.path, moveEdge(drag.sizes, edge.index, moved, min));
      }}
      onPointerUp={() => {
        setDrag(undefined);
        onDragChange(false);
      }}
      onPointerCancel={() => {
        setDrag(undefined);
        onDragChange(false);
      }}
      onDoubleClick={evenOut}
      onKeyDown={onKeyDown}
      style={
        row
          ? {
              left: `calc(${edge.at * 100}% - 4px)`,
              top: `${edge.box.y * 100}%`,
              height: `${edge.box.height * 100}%`,
            }
          : {
              top: `calc(${edge.at * 100}% - 4px)`,
              left: `${edge.box.x * 100}%`,
              width: `${edge.box.width * 100}%`,
            }
      }
      className={`group absolute z-20 touch-none outline-none ${
        row ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"
      }`}
    >
      {/* The seam only shows once it's reached for, so the area stays quiet. */}
      <span
        className={`absolute rounded-full bg-fg-tertiary opacity-0 transition-opacity delay-150 duration-150 group-hover:opacity-60 group-focus-visible:opacity-80 group-data-dragging:opacity-80 group-data-dragging:delay-0 ${
          row ? "inset-y-4 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-4 top-1/2 h-0.5 -translate-y-1/2"
        }`}
      />
    </div>
  );
}
