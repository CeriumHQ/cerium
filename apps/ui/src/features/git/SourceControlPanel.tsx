import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { useShortcut } from "../../lib/shortcuts.ts";

type Tab = "changes" | "history";

const toggleClass =
  "rounded-md px-2 py-0.5 text-body font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[15px]";

/**
 * Source control, beside the conversation: the repository the open work thread's folder is in, what
 * changed in it and what was committed. Its header holds what's checked out and the way to sync it.
 */
export function SourceControlPanel({
  header,
  notice,
  changes,
  changeCount,
  history,
  onRefresh,
  onClose,
}: {
  /** What's checked out and syncing it; the panel's name until there's something to say. */
  header?: ReactNode;
  /** A line under the header, on either tab: what the last change told the user. */
  notice?: ReactNode;
  /** The Changes tab: what's staged, what isn't, and the commit box. */
  changes: ReactNode;
  /** How many files the Changes tab lists, beside its name. */
  changeCount: number;
  /** The History tab, where the machine can list commits. */
  history?: ReactNode;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("changes");
  const element = useRef<HTMLDivElement>(null);
  const shown = history === undefined ? "changes" : tab;

  // Esc closes the panel while focus is inside it, unless something there (a field, a menu) used the key first.
  const onEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      element.current?.contains(document.activeElement)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div ref={element} className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2 max-md:h-12 max-md:pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {header ?? (
            <h2 className="truncate px-1 text-body font-medium text-fg-primary max-md:text-[15px]">
              Source control
            </h2>
          )}
        </div>
        <IconButton icon={RefreshCw} label="Refresh" onClick={onRefresh} className="max-md:size-10" />
        <IconButton
          icon={X}
          label="Close"
          shortcut={useShortcut("toggle-source-control")}
          onClick={onClose}
          className="max-md:size-10"
        />
      </header>
      {notice}
      {history === undefined ? null : (
        <div className="flex h-9 shrink-0 items-center border-b border-line-subtle px-2 max-md:h-11">
          <ToggleGroup
            value={[shown]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "changes" || next === "history") setTab(next);
            }}
            aria-label="Show"
            className="flex items-center"
          >
            <Toggle value="changes" className={toggleClass}>
              Changes
              {changeCount > 0 ? (
                <span className="ml-1.5 text-fg-tertiary tabular-nums">{changeCount}</span>
              ) : null}
            </Toggle>
            <Toggle value="history" className={toggleClass}>
              History
            </Toggle>
          </ToggleGroup>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {shown === "history" ? history : <ScrollArea className="h-full">{changes}</ScrollArea>}
      </div>
    </div>
  );
}
