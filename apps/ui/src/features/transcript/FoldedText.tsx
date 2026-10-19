import { useState, type ReactNode } from "react";

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
  const { lines, folds } = foldOf(text);
  if (!folds) return children;
  return (
    <>
      <div className={open ? "" : "max-h-60 overflow-hidden mask-b-from-55% mask-b-to-100%"}>{children}</div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-1 -mb-0.5 rounded text-xs text-fg-tertiary transition-colors hover:text-fg-primary max-md:py-1.5"
      >
        {open ? "Show less" : lines > 1 ? `Show all ${lines} lines` : "Show more"}
      </button>
    </>
  );
}
