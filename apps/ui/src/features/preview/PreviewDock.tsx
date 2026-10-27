import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ResizeHandle } from "../../app/ResizeHandle.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { DOCK, dockLayout } from "./model.ts";

const storedShare = () => {
  const saved = Number(stored(DOCK.key));
  return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : DOCK.share;
};

/**
 * A thread's conversation, with its preview docked to the right while it shows: a share of the pane
 * the user drags to size, remembered across launches. A pane too narrow for both gives the preview
 * all of it, over the conversation, until it closes. The conversation keeps its place in the tree
 * either way, so showing the preview never draws it afresh.
 */
export function PreviewDock({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [share, setShare] = useState(storedShare);
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return;
    const measure = () => setRowWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shows = preview != null && rowWidth > 0;
  const layout = dockLayout(rowWidth, share);
  const covers = shows && layout.covers;
  return (
    <div ref={row} className="relative flex h-full">
      <div inert={covers} className="h-full min-w-0 flex-1">
        {children}
      </div>
      {!shows ? null : covers ? (
        <aside className="absolute inset-0 z-20 bg-surface-pane">{preview}</aside>
      ) : (
        <>
          <div className="relative w-0 shrink-0">
            <ResizeHandle
              label="Resize preview"
              edge="start"
              width={layout.width}
              min={layout.min}
              max={layout.max}
              fallback={Math.round(DOCK.share * rowWidth)}
              onResize={(width) => setShare(width / rowWidth)}
              onCommit={(width) => remember(DOCK.key, String(width / rowWidth))}
              onDragChange={() => undefined}
            />
          </div>
          <aside style={{ width: layout.width }} className="h-full shrink-0 border-l border-line-subtle">
            {preview}
          </aside>
        </>
      )}
    </div>
  );
}
