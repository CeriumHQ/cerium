import { CircleAlert, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

/** A slim bar across the top of the transcript for problems worth the user's attention. */
export function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "attention" | "error";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[12.5px] text-fg-secondary [&_code]:rounded [&_code]:bg-surface-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-fg-primary ${
        tone === "error" ? "border-error/25" : "border-attention/25"
      }`}
    >
      <Icon
        size={13}
        strokeWidth={2}
        className={`shrink-0 ${tone === "error" ? "text-error" : "text-attention"}`}
      />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid size-5 place-items-center rounded text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
