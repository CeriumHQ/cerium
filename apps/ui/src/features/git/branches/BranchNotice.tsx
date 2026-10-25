import { X } from "lucide-react";

import type { BranchControls } from "./useBranchControls.ts";

const tones = {
  error: "text-error",
  attention: "text-attention",
  info: "text-fg-secondary",
} as const;

/** What the branch controls last told the user, in a line under the header until it goes or is dismissed. */
export function BranchNotice({ controls }: { readonly controls: BranchControls }) {
  const message = controls.message;
  if (message === undefined) return null;
  return (
    <div
      role={message.tone === "error" ? "alert" : "status"}
      className="flex items-start gap-2 border-b border-line-subtle bg-surface-sunken py-1.5 pr-1.5 pl-3 text-meta max-md:text-[14px]"
    >
      <p className={`min-w-0 flex-1 leading-snug ${tones[message.tone]}`}>{message.text}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={controls.dismiss}
        className="grid size-5 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary max-md:size-8"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
