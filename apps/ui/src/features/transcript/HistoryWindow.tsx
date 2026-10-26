import { Button } from "@base-ui/react/button";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** Search and artifact navigation can ask the visible conversation to materialize its older pages. */
export const HISTORY_EVENT = "cerium:history";
const PAGE = 80;

/** Recent history first. Explicit pages avoid guessed heights and keep prepends anchored. */
export function HistoryWindow<A extends { readonly id: string }>({
  items,
  viewport,
  render,
}: {
  items: ReadonlyArray<A>;
  viewport: RefObject<HTMLDivElement | null>;
  render: (item: A) => ReactNode;
}) {
  const [first, setFirst] = useState<string>();
  const [all, setAll] = useState(false);
  const marker = useRef<HTMLSpanElement>(null);
  const anchor = useRef<{ element: Element; top: number }>(undefined);
  const initial = Math.max(0, items.length - PAGE);
  const index = first === undefined ? initial : items.findIndex((item) => item.id === first);
  const start = all ? 0 : Math.max(0, index);
  // Keep the first page fixed as a live conversation grows.
  if (first === undefined && items[start]) setFirst(items[start].id);
  useEffect(() => {
    const reveal = () => {
      if (marker.current?.checkVisibility()) setAll(true);
    };
    window.addEventListener(HISTORY_EVENT, reveal);
    return () => window.removeEventListener(HISTORY_EVENT, reveal);
  }, []);
  useLayoutEffect(() => {
    const held = anchor.current;
    if (held && viewport.current) {
      viewport.current.scrollBy({
        top: held.element.getBoundingClientRect().top - held.top,
        behavior: "instant",
      });
      anchor.current = undefined;
    }
  }, [start, viewport]);
  return (
    <>
      <span ref={marker} aria-hidden className="h-0" />
      {start > 0 ? (
        <Button
          className="self-center rounded-md px-3 py-2 text-meta text-fg-secondary hover:bg-surface-hover"
          onClick={() => {
            const element = marker.current?.nextElementSibling?.nextElementSibling;
            if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
            // Prepending is reading history, so the bottom follower must yield before layout changes.
            marker.current?.dispatchEvent(new Event("cerium:reveal", { bubbles: true }));
            setFirst(items[Math.max(0, start - PAGE)]?.id);
          }}
        >
          Show earlier messages
        </Button>
      ) : null}
      {items.slice(start).map(render)}
    </>
  );
}
