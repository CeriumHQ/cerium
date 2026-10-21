import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { remember, stored } from "../lib/storage.ts";
import { clampWidth } from "./panelLayout.ts";

const storedWidth = (key: string, fallback: number) => {
  const saved = Number(stored(key));
  return Number.isFinite(saved) && saved > 0 ? saved : fallback;
};

/** A panel's width as the user last left it, remembered between launches; `fallback` until they have. */
export function usePanelWidth(key: string, fallback: number) {
  const [width, setWidth] = useState(() => storedWidth(key, fallback));
  return [
    width,
    setWidth,
    // Saved once the drag lets go, not on every pixel of it.
    (next: number) => remember(key, String(Math.round(next))),
  ] as const;
}

/**
 * The widths of panels that take turns in one place, each as the user last left it: `usePanelWidth`
 * for whichever of `panels` shows.
 */
export function usePanelWidths<Id extends string>(
  panels: Readonly<Record<Id, { readonly key: string; readonly fallback: number }>>,
  shown: Id,
) {
  const [widths, setWidths] = useState<Partial<Record<Id, number>>>({});
  const { key, fallback } = panels[shown];
  return [
    widths[shown] ?? storedWidth(key, fallback),
    (next: number) => setWidths((current) => ({ ...current, [shown]: next })),
    (next: number) => remember(key, String(Math.round(next))),
  ] as const;
}

/** What an arrow key moves a panel by, and with Shift held. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * The edge between a panel and what's beside it, to drag (or nudge with the arrow keys) to resize the
 * panel. Double-click, or Enter, puts it back to its own width. Place it in a zero-width, relatively
 * positioned wrapper on the seam; it overhangs the wrapper by half its own width.
 *
 * `edge` is which side of the panel it's on: "end" for a panel on the left (dragging right widens it),
 * "start" for a panel on the right (dragging left does).
 */
export function ResizeHandle({
  label,
  edge,
  width,
  min,
  max,
  fallback,
  onResize,
  onCommit,
  onDragChange,
}: {
  /** Names what it resizes, such as "Resize sidebar". */
  label: string;
  edge: "start" | "end";
  width: number;
  min: number;
  max: number;
  /** The width double-click returns to. */
  fallback: number;
  onResize: (width: number) => void;
  /** The width the user settled on, to remember. */
  onCommit: (width: number) => void;
  /** While a drag is under way, so the panel can follow the pointer without easing behind it. */
  onDragChange: (dragging: boolean) => void;
}) {
  const [drag, setDrag] = useState<{ readonly x: number; readonly width: number }>();
  const direction = edge === "end" ? 1 : -1;

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) onResize(clampWidth(drag.width + (event.clientX - drag.x) * direction, min, max));
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    onCommit(clampWidth(drag.width + (event.clientX - drag.x) * direction, min, max));
    setDrag(undefined);
    onDragChange(false);
  };
  const set = (next: number) => {
    const clamped = clampWidth(next, min, max);
    onResize(clamped);
    onCommit(clamped);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    if (event.key === "ArrowRight") set(width + step * direction);
    else if (event.key === "ArrowLeft") set(width - step * direction);
    else if (event.key === "Home") set(min);
    else if (event.key === "End") set(max);
    else if (event.key === "Enter") set(fallback);
    else return;
    event.preventDefault();
  };

  return (
    <div
      // A splitter that takes focus and keys is a widget, which `hr` can't be.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={drag ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x: event.clientX, width });
        onDragChange(true);
      }}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={() => set(fallback)}
      onKeyDown={onKeyDown}
      className={`group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none ${
        edge === "end" ? "-left-[7px]" : "-left-px"
      }`}
    >
      {/* The seam only shows once it's reached for, so the frame stays quiet. */}
      <span className="absolute inset-y-4 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-fg-tertiary opacity-0 transition-opacity delay-150 duration-150 group-hover:opacity-60 group-focus-visible:opacity-80 group-data-dragging:opacity-80 group-data-dragging:delay-0" />
    </div>
  );
}
