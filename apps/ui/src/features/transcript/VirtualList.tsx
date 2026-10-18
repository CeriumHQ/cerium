import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface VirtualListProps<T> {
  readonly items: ReadonlyArray<T>;
  readonly keyOf: (item: T) => string;
  /** The element that scrolls the list. */
  readonly viewport: RefObject<HTMLDivElement | null>;
  /**
   * The CSS zoom the list sits in. The virtualizer works in the viewport's pixels, which the zoom
   * scales; the list's own lengths are unzoomed.
   */
  readonly zoom: number;
  /** Space between items, in the list's own pixels. */
  readonly gap: number;
  /** A guess at an item's height before it is measured, in the list's own pixels. */
  readonly estimate: number;
  /** Heights already known, on screen, by key: an item drawn elsewhere before it joined the list. */
  readonly sizes?: ReadonlyMap<string, number>;
  /**
   * Whether the viewport follows the end of what it scrolls. While it does, whatever follows keeps
   * the end in view, so the list leaves the scroll position alone as its items are measured.
   */
  readonly following: () => boolean;
  readonly children: (item: T) => ReactNode;
}

/** Items laid out beyond the visible ones on each side, so a quick scroll rarely shows a gap. */
const OVERSCAN = 6;

/**
 * A long list that mounts only the items in and near view, each measured as it renders. It starts
 * at its end, where a conversation opens, so the first paint is already its latest items.
 *
 * Items are placed absolutely, so the list's height follows their growth a render late; content
 * that grows as it is watched belongs after it, in the page's own flow.
 */
export function VirtualList<T>({
  items,
  keyOf,
  viewport,
  zoom,
  gap,
  estimate,
  sizes,
  following,
  children,
}: VirtualListProps<T>) {
  // The virtualizer keeps its state in one long-lived object and redraws by mutating it; the React
  // Compiler would cache what it returns and draw stale rows.
  "use no memo";
  const list = useRef<HTMLDivElement>(null);
  /** Where the list starts within what the viewport scrolls, in the viewport's pixels. */
  const [start, setStart] = useState(0);
  // Known to the compiler too, which skips this component: nothing it returns reaches a memoized one.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport.current,
    getItemKey: (index) => keyOf(items[index]!),
    estimateSize: (index) => sizes?.get(keyOf(items[index]!)) ?? estimate * zoom,
    // On screen, as the viewport scrolls: the zoom is in it, which an element's own box sizes leave out.
    measureElement: (element) => element.getBoundingClientRect().height,
    gap: gap * zoom,
    overscan: OVERSCAN,
    scrollMargin: start,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
  });
  // Reading further up, an item above the view that turns out taller or shorter than guessed moves
  // the view by as much, so what is being read stays put. At the end there's nothing to hold: moving
  // the view there would read as the reader scrolling up, and stop it following.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    !following() && item.start < (instance.scrollOffset ?? 0);

  useLayoutEffect(() => {
    const element = list.current;
    const scroller = viewport.current;
    if (!element || !scroller) return;
    const measure = () =>
      setStart(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      );
    measure();
    // The padding above the list follows the window's width and the text size.
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [viewport, zoom]);

  return (
    <div ref={list} className="relative" style={{ height: virtualizer.getTotalSize() / zoom }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${(row.start - start) / zoom}px)` }}
        >
          {children(items[row.index]!)}
        </div>
      ))}
    </div>
  );
}
