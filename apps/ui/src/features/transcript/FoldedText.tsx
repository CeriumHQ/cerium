import { flushSync } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { UNFOLD_EVENT } from "./find.ts";

/** A message past this many lines, or characters, shows its first lines and folds the rest. */
const FOLD_LINES = 14;
const FOLD_CHARACTERS = 1500;

/** How many lines `text` has, and whether that is long enough to fold. */
export const foldOf = (text: string): { readonly lines: number; readonly folds: boolean } => {
  const lines = text.trimEnd().split("\n").length;
  return { lines, folds: lines > FOLD_LINES || text.length > FOLD_CHARACTERS };
};

/**
 * A long message folded to its first lines with a button that opens the rest, so a pasted log
 * doesn't push the conversation off screen. A short one shows as it is.
 */
export function FoldedText({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const fold = useRef<HTMLDivElement>(null);
  const { lines, folds } = foldOf(text);
  // A find match inside the folded part opens it, at once, so the match can be brought into view.
  useEffect(() => {
    const element = fold.current;
    if (!element) return;
    const unfold = () => flushSync(() => setOpen(true));
    element.addEventListener(UNFOLD_EVENT, unfold);
    return () => element.removeEventListener(UNFOLD_EVENT, unfold);
  }, [folds]);
  if (!folds) return children;
  return (
    <>
      <div ref={fold} className={open ? "" : "max-h-60 overflow-hidden mask-b-from-55% mask-b-to-100%"}>
        {children}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-1 -mb-0.5 rounded text-meta text-fg-tertiary transition-colors hover:text-fg-primary max-md:py-1.5"
      >
        {open ? "Show less" : lines > 1 ? `Show all ${lines} lines` : "Show more"}
      </button>
    </>
  );
}
