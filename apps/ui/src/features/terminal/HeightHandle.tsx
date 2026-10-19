import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { clampWidth } from "../../app/panelLayout.ts";

/** What an arrow key moves the drawer by, and with Shift held. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * The drawer's top edge, to drag (or nudge with the arrow keys) to resize the drawer. Dragging up
 * makes it taller. Double-click, or Enter, puts it back to its own height. Place it in the drawer's
 * top edge; it overhangs it by half its own height. Like the panels' side handles (app/ResizeHandle),
 * the seam shows only once it's reached for.
 */
export function HeightHandle({
  height,
  min,
  max,
  fallback,
  onResize,
  onCommit,
}: {
  height: number;
  min: number;
  max: number;
  /** The height double-click returns to. */
  fallback: number;
  onResize: (height: number) => void;
  /** The height the user settled on, to remember. */
  onCommit: (height: number) => void;
}) {
  const [drag, setDrag] = useState<{ readonly y: number; readonly height: number }>();

  const heightAt = (event: PointerEvent<HTMLDivElement>) =>
    drag ? clampWidth(drag.height + (drag.y - event.clientY), min, max) : height;
  const set = (next: number) => {
    const clamped = clampWidth(next, min, max);
    onResize(clamped);
    onCommit(clamped);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    if (event.key === "ArrowUp") set(height + step);
    else if (event.key === "ArrowDown") set(height - step);
    else if (event.key === "Home") set(max);
    else if (event.key === "End") set(min);
    else if (event.key === "Enter") set(fallback);
    else return;
    event.preventDefault();
  };

  return (
    <div
      // A splitter that takes focus and keys is a widget, which `hr` can't be.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      aria-valuenow={Math.round(height)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={drag ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ y: event.clientY, height });
      }}
      onPointerMove={(event) => {
        if (drag) onResize(heightAt(event));
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        onCommit(heightAt(event));
        setDrag(undefined);
      }}
      onPointerCancel={() => setDrag(undefined)}
      onDoubleClick={() => set(fallback)}
      onKeyDown={onKeyDown}
      className="group absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none"
    >
      <span className="absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-fg-tertiary opacity-0 transition-opacity delay-150 duration-150 group-hover:opacity-60 group-focus-visible:opacity-80 group-data-dragging:opacity-80 group-data-dragging:delay-0" />
    </div>
  );
}
