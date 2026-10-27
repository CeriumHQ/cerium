import { CircleAlert, CircleArrowUp, TriangleAlert, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A slim bar across the top of the transcript for problems worth the user's attention, or news that
 * asks for a decision, such as an update to install.
 *
 * `clamp` is for text whose length isn't ours to choose, such as an error a backend reports: it shows
 * two lines and unfolds on request. Leave it off where the notice carries links, which would fold away.
 */
export function Notice({
  tone,
  children,
  onDismiss,
  clamp = false,
}: {
  tone: "attention" | "error" | "update";
  children: ReactNode;
  onDismiss?: () => void;
  clamp?: boolean;
}) {
  const Icon = tone === "error" ? CircleAlert : tone === "update" ? CircleArrowUp : TriangleAlert;
  const [expanded, setExpanded] = useState(false);
  /** Whether the text runs past its two lines, so there's something to unfold. */
  const [overflowing, setOverflowing] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = text.current;
    if (!clamp || !element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    // A narrower window wraps the same text onto more lines.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp, expanded, children]);
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 text-meta leading-[1.4] text-fg-secondary max-md:text-[13px] [&_code]:rounded [&_code]:bg-surface-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-caption [&_code]:text-fg-primary ${
        tone === "error"
          ? "border-error/25 bg-error/6"
          : tone === "update"
            ? "border-accent/25 bg-accent/6"
            : "border-attention/25 bg-attention/6"
      }`}
    >
      {/* One line tall, so the icon sits on the first line of text however long the rest runs. */}
      <span className="grid h-[1.4em] shrink-0 place-items-center">
        <Icon
          size={13}
          strokeWidth={2}
          className={
            tone === "error" ? "text-error-text" : tone === "update" ? "text-accent" : "text-attention-text"
          }
        />
      </span>
      <span ref={text} className={`min-w-0 flex-1 ${clamp && !expanded ? "line-clamp-2" : ""}`}>
        {children}
      </span>
      {clamp && (overflowing || expanded) ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="shrink-0 rounded px-1 font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-0.5 -mr-1 grid size-6 shrink-0 place-items-center rounded text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary max-md:-my-1.5 max-md:size-8"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
