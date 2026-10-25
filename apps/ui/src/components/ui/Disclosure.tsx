import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Detail that stays folded until it's asked for: a quiet line naming what's inside, and while folded,
 * what it holds at a glance, over a panel that opens in place.
 */
export function Disclosure({
  summary,
  hint,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: {
  /** Names what's inside, such as "Advanced". */
  summary: ReactNode;
  /** What's inside at a glance, shown while folded, such as "3 settings" or "2 failed". */
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controls it from outside; leave both out and it keeps its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}
      {...(className ? { className } : {})}
    >
      <Collapsible.Trigger className="group -ml-1 flex max-w-full items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1 text-body text-fg-secondary transition-colors select-none hover:text-fg-primary data-panel-open:text-fg-primary max-md:py-2">
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="shrink-0 font-medium">{summary}</span>
        {hint ? (
          <span className="min-w-0 truncate text-fg-tertiary group-data-panel-open:hidden">{hint}</span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        {/* Room around the content for its focus rings, which the folding panel would clip. */}
        <div className="-mx-1 px-1 pt-2 pb-1">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
