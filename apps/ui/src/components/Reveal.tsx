import { useRef, type CSSProperties, type ReactNode } from "react";

import { usePresence, useRetained } from "../lib/motion.ts";

/**
 * Content that grows into place when it arrives and folds away before it goes, moving what sits
 * beside it smoothly instead of making it jump (`.reveal` in styles/app.css). It shows while it has
 * children, and keeps the last ones, inert, while it folds. Room around the content (padding, a gap)
 * belongs inside it, or that room would stay behind when it folds.
 */
export function Reveal({
  children,
  appear = true,
  shift,
  className = "",
}: {
  children: ReactNode;
  /** Also grows into place when it first mounts with children; off for content that was already there. */
  appear?: boolean;
  /** How far it moves along the way: positive rises from below, negative drops from above. */
  shift?: number;
  className?: string;
}) {
  const show = children !== null && children !== undefined && children !== false;
  const content = useRetained(children, show);
  const element = useRef<HTMLDivElement>(null);
  const phase = usePresence(show, element, { appear });
  if (phase === "gone") return null;
  return (
    <div
      ref={element}
      data-phase={phase}
      inert={phase === "leaving"}
      style={shift === undefined ? undefined : ({ "--reveal-shift": `${shift}px` } as CSSProperties)}
      className={`reveal ${className}`}
    >
      <div>{content}</div>
    </div>
  );
}
