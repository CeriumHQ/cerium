import { useEffect, useRef, useState, type ReactNode } from "react";

/** Keep only nearby rows mounted. Remember real wrapped heights when a chunk leaves view. */
export function VisibleChunk({ height, children }: { height: number; children: () => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [measured, setMeasured] = useState<number>();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const selection = document.getSelection();
        const selected =
          selection &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          selection.getRangeAt(0).intersectsNode(element);
        setNear(
          entry?.isIntersecting === true || element.contains(document.activeElement) || Boolean(selected),
        );
      },
      {
        rootMargin: "1000px",
        scrollMargin: "1000px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = box.current;
    if (!near || !element) return;
    const observer = new ResizeObserver(() => {
      setMeasured(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return (
    <div ref={box} style={near ? undefined : { height: measured ?? height }}>
      {near ? children() : null}
    </div>
  );
}
