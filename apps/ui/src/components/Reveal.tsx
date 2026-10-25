import { useRef, type CSSProperties, type ReactNode } from "react";

import { usePresence, useRetained } from "../lib/motion.ts";

/**
 * Content that comes and goes in motion (`.reveal` and `.pop` in styles/app.css). It shows while it
 * has children, and keeps the last ones, inert, while it leaves. A fold grows into place and folds
 * away, moving what sits beside it smoothly instead of making it jump; room around folding content
 * (padding, a gap) belongs inside it, or that room would stay behind. A pop scales in and out where it
 * stands, for a tile among others.
 */
export function Reveal({
  children,
  kind = "fold",
  appear = true,
  shift,
  onGone,
  className = "",
}: {
  children: ReactNode;
  kind?: "fold" | "pop";
  /** Also arrives when it first mounts with children; off for content that was already there. */
  appear?: boolean;
  /** How far a fold moves along the way: positive rises from below, negative drops from above. */
  shift?: number;
  /** It has left, after its children went. */
  onGone?: () => void;
  className?: string;
}) {
  const show = children !== null && children !== undefined && children !== false;
  const content = useRetained(children, show);
  const element = useRef<HTMLDivElement>(null);
  const phase = usePresence(show, element, { appear, onGone });
  if (phase === "gone") return null;
  return (
    <div
      ref={element}
      data-phase={phase}
      inert={phase === "leaving"}
      style={shift === undefined ? undefined : ({ "--reveal-shift": `${shift}px` } as CSSProperties)}
      className={`${kind === "fold" ? "reveal" : "pop"} ${className}`}
    >
      {kind === "fold" ? <div>{content}</div> : content}
    </div>
  );
}
