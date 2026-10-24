import { Button } from "@base-ui/react/button";
import { LoaderCircle, PenLine } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip } from "./Tooltip.tsx";

/**
 * The button that has a quick model write a field's text: a square with the pen alone, or with
 * its words beside it. While the model writes it turns, and a press does nothing.
 */
export function GenerateButton({
  label,
  busy,
  disabled = false,
  onClick,
  children,
  className,
}: {
  /** What it writes, for the tooltip and the button's name: "Write the message from the changes". */
  readonly label: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  /** Words beside the pen; without them the button is a square. */
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const Icon = busy ? LoaderCircle : PenLine;
  return (
    <Tooltip label={busy ? "Writing…" : label}>
      <Button
        aria-label={children === undefined ? label : undefined}
        aria-busy={busy}
        onClick={() => {
          if (!busy) onClick();
        }}
        disabled={disabled}
        focusableWhenDisabled
        className={`flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-fg-tertiary transition-colors outline-none hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-1 focus-visible:ring-focus-ring data-disabled:cursor-default data-disabled:text-fg-disabled data-disabled:hover:bg-transparent aria-busy:text-fg-secondary ${
          children === undefined
            ? "size-7 max-md:size-10"
            : "h-8 px-2.5 text-[13px] font-medium max-md:h-10 max-md:text-[15px]"
        } ${className ?? ""}`}
      >
        <Icon size={14} strokeWidth={1.75} className={busy ? "animate-spin" : undefined} aria-hidden="true" />
        {children}
      </Button>
    </Tooltip>
  );
}
