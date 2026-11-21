import { useRef, type ReactNode } from "react";

import { usePresence, useRetained } from "../../lib/motion.ts";

/** Keeps the last results visible as the menu leaves, while the editor takes its keys back. */
export function ComposerMenu({ children }: { children: ReactNode }) {
  const open = children != null;
  const content = useRetained(children, open);
  const popup = useRef<HTMLDivElement>(null);
  const phase = usePresence(open, popup);
  if (phase === "gone") return null;
  return (
    <div
      ref={popup}
      data-phase={phase}
      inert={!open}
      className="input-popup pointer-events-auto absolute inset-x-0 bottom-full z-10 mb-2 overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay shadow-overlay backdrop-blur-2xl"
    >
      {content}
    </div>
  );
}
