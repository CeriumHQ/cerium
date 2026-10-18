import { Button } from "@base-ui/react/button";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The narrow window's top bar (docs/architecture.md §14.10), past the status bar and the notch: what
 * the pane is, with the way back to the one before it.
 */
export function CompactBar({
  back,
  title,
  subtitle,
  leading,
  trailing,
}: {
  /** Returns to the pane before, named by `label`. */
  back?: { readonly label: string; readonly onBack: () => void };
  title?: string;
  subtitle?: string;
  /** In place of the back button and title, such as the inbox's brand and mode. */
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="shrink-0 pt-[env(safe-area-inset-top)] pr-[max(env(safe-area-inset-right),0.5rem)] pl-[max(env(safe-area-inset-left),0.5rem)]">
      <div className="flex h-12 items-center gap-1">
        {back ? (
          <Button
            onClick={back.onBack}
            aria-label={`Back to ${back.label}`}
            className="-ml-0.5 flex h-10 shrink-0 items-center gap-0.5 rounded-lg pr-2 pl-0.5 text-[15px] text-fg-secondary transition-colors active:bg-surface-active"
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
            {title === undefined ? back.label : null}
          </Button>
        ) : null}
        {leading}
        {title !== undefined ? (
          <div className={`flex min-w-0 flex-1 flex-col ${back ? "" : "pl-2"}`}>
            <span className="truncate text-[15px] leading-tight font-semibold text-fg-primary">{title}</span>
            {subtitle ? (
              <span className="truncate text-xs leading-tight text-fg-tertiary">{subtitle}</span>
            ) : null}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {trailing}
      </div>
    </header>
  );
}
