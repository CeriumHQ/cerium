import { Search, X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "./IconButton.tsx";

/** A button at the bar's end that opens a popup: quiet until hovered, lit while open or set. */
export const barButtonClass =
  "relative grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active data-popup-open:text-fg-primary max-md:size-10";

/** A small count on the corner of a control. */
export function CountBadge({
  count,
  tone = "accent",
  className,
}: {
  count: number;
  tone?: "accent" | "neutral";
  className?: string;
}) {
  return (
    <span
      className={`absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-1 text-[9px] leading-none font-semibold tabular-nums ${tone === "accent" ? "bg-accent text-accent-fg" : "bg-surface-selected text-fg-primary"} ${className ?? ""}`}
    >
      {count}
    </span>
  );
}

/** How many filters are set, as a small count on the corner of the button that sets them. */
export function SetCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <CountBadge count={count} />;
}

/**
 * The search over a panel's list, flush under the panel's header as the Files panel's filter is, with
 * the list's own buttons (its filters, a new item) at the end. Esc clears what's typed before anything
 * else hears it.
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  label = placeholder,
  flush = false,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The field's accessible name, the placeholder unless it says more. */
  label?: string;
  /** Sits inside a card that draws its own edge, so the bar's bottom border goes. */
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-3 max-md:h-12 ${flush ? "" : "border-b border-line-subtle"}`}
    >
      <label className="flex h-full min-w-0 flex-1 items-center gap-2 text-fg-tertiary">
        <Search size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        <input
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value !== "") {
              event.preventDefault();
              event.stopPropagation();
              onChange("");
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-meta text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[14px]"
        />
      </label>
      {value === "" ? null : (
        <IconButton icon={X} label="Clear the search" onClick={() => onChange("")} className="size-6" />
      )}
      {children}
    </div>
  );
}
