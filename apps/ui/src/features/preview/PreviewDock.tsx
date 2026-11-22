import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ResizeHandle } from "../../app/ResizeHandle.tsx";
import { usePresence, useRetained } from "../../lib/motion.ts";
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
  const panel = useRef<HTMLElement>(null);
  const phase = usePresence(shows, panel);
  const content = useRetained(preview, shows);
  return (
    <div ref={row} className="relative flex h-full overflow-clip">
      <div inert={shows && layout.covers} className="h-full min-w-0 flex-1 [&[inert]]:opacity-0">
        {children}
      </div>
      {shows && !layout.covers ? (
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
      ) : null}
      {phase !== "gone" ? (
        <aside
          ref={panel}
          inert={!shows}
          data-phase={phase}
          data-preview-moving={phase !== "shown" ? "" : undefined}
          style={{ "--preview-width": `${layout.width}px` } as CSSProperties}
          className={`h-full overflow-clip data-[phase=entering]:starting:opacity-0 data-[phase=leaving]:opacity-0 motion-reduce:transition-none ${
            phase === "shown" ? "duration-0" : "duration-200 ease-out-soft"
          } ${
            layout.covers
              ? "absolute inset-0 z-20 bg-surface-pane transition-[translate,opacity] data-[phase=entering]:starting:translate-x-4 data-[phase=leaving]:translate-x-4"
              : "w-(--preview-width) shrink-0 transition-[width,opacity] data-[phase=entering]:starting:w-0 data-[phase=leaving]:w-0"
          }`}
        >
          <div className={`h-full w-(--preview-width) ${layout.covers ? "" : "border-l border-line-subtle"}`}>
            {content}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
