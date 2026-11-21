import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * The browser's own choice list, set quietly inside a line of text or a toolbar, as a toolbar trigger
 * looks: for a handful of choices that a full menu would be too much for. Its options open natively,
 * in the system's own list, which follows the theme's light or dark mode.
 */
export function InlineSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={`relative inline-flex min-w-0 items-center ${className ?? ""}`}>
      <select
        {...props}
        className="h-6 w-full min-w-0 cursor-default appearance-none truncate rounded-md bg-transparent pr-6 pl-1.5 text-meta font-medium text-fg-secondary transition-colors duration-150 outline-none hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 max-md:h-9 max-md:text-[14px] [&_option]:bg-surface-window [&_option]:text-fg-primary"
      />
      <ChevronDown
        size={12}
        strokeWidth={2}
        aria-hidden
        className="pointer-events-none absolute right-1.5 text-fg-tertiary"
      />
    </span>
  );
}
