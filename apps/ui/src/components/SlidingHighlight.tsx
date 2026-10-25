import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The selected item's background, one shape that slides from the item that was selected to the one
 * that is, instead of jumping between them. It sits under the item inside `within` marked
 * `data-highlight-active`, and fades out while none is. `within` is positioned (`relative`) and
 * isolated (`isolate`), so the highlight stays under its items; `active` names the selected item, so
 * it moves when that changes. Where it first shows it is simply there.
 */
export function SlidingHighlight({
  within,
  active,
  className = "",
}: {
  within: RefObject<HTMLElement | null>;
  active: string | undefined;
  className?: string;
}) {
  const highlight = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = within.current;
    const mark = highlight.current;
    if (container === null || mark === null) return;
    const place = () => {
      const target = container.querySelector<HTMLElement>("[data-highlight-active]");
      mark.style.opacity = target === null ? "0" : "1";
      if (target === null) return;
      mark.style.translate = `${target.offsetLeft}px ${target.offsetTop}px`;
      mark.style.width = `${target.offsetWidth}px`;
      mark.style.height = `${target.offsetHeight}px`;
    };
    place();
    // The items move as the window or the list resizes.
    const observer = new ResizeObserver(place);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, within]);
  // Only once it has been placed: from its first place, it would slide in from the corner.
  useEffect(() => {
    const frame = requestAnimationFrame(() => highlight.current?.setAttribute("data-placed", ""));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      ref={highlight}
      aria-hidden
      className={`pointer-events-none absolute top-0 left-0 -z-10 opacity-0 data-placed:transition-[translate,width,height,opacity] data-placed:duration-200 data-placed:ease-out-soft ${className}`}
    />
  );
}
