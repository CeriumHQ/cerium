import { Button } from "@base-ui/react/button";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

import { connectionSubtitle, statusMark, type ShownStatus } from "./connectionStatus.ts";
import { NoticeSwap } from "./Notice.tsx";

/** One line of `text-meta leading-tight`, whatever it holds, so a swap never moves the title. */
const subtitleLine = "flex h-[1.25em] min-w-0 items-center gap-1.5 text-meta leading-tight text-fg-tertiary";

/**
 * The narrow window's top bar, past the status bar and the notch: what the pane is,
 * with the way back to the one before it.
 */
export function CompactBar({
  back,
  title,
  subtitle,
  subtitleKey,
  onTitleClick,
  leading,
  trailing,
  folded = false,
}: {
  /** Returns to the pane before, named by `label`. */
  back?: { readonly label: string; readonly onBack: () => void };
  title?: string;
  subtitle?: ReactNode;
  /** Names what the subtitle shows: a new key crossfades to it in place, and is announced. */
  subtitleKey?: string | undefined;
  /** Makes the title and subtitle one tap target, such as for the thread's sheet. */
  onTitleClick?: (() => void) | undefined;
  /** In place of the back button and title, such as the inbox's brand and mode. */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Folded away to the status bar, such as while the keyboard is up, giving the pane its room. */
  folded?: boolean;
}) {
  const content = (
    <span className={subtitleLine}>
      {typeof subtitle === "string" ? <span className="min-w-0 truncate">{subtitle}</span> : subtitle}
    </span>
  );
  const line =
    subtitleKey !== undefined ? (
      <span aria-live="polite" className="block min-w-0">
        <NoticeSwap kind={subtitleKey} className="min-w-0">
          {content}
        </NoticeSwap>
      </span>
    ) : subtitle ? (
      content
    ) : null;
  const heading = (
    <>
      <span className="truncate text-reading leading-tight font-semibold text-fg-primary">{title}</span>
      {line}
    </>
  );
  return (
    <header
      inert={folded}
      className={`grid shrink-0 pt-[env(safe-area-inset-top)] pr-[max(env(safe-area-inset-right),0.5rem)] pl-[max(env(safe-area-inset-left),0.5rem)] transition-[grid-template-rows,opacity] duration-200 ease-out-soft ${
        folded ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
      }`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex h-12 items-center gap-1">
          {back ? (
            <Button
              onClick={back.onBack}
              aria-label={`Back to ${back.label}`}
              className="-ml-0.5 flex h-10 min-w-10 shrink-0 items-center gap-0.5 rounded-lg pr-2 pl-0.5 text-reading text-fg-secondary transition-colors active:bg-surface-active"
            >
              <ChevronLeft size={22} strokeWidth={1.75} />
              {title === undefined ? back.label : null}
            </Button>
          ) : null}
          {leading}
          {title !== undefined && onTitleClick ? (
            <Button
              onClick={onTitleClick}
              aria-label={title ? `${title}, thread details` : "Thread details"}
              className={`flex min-h-10 min-w-0 flex-1 flex-col justify-center rounded-lg pr-1.5 text-left transition-colors duration-150 ease-out-soft select-none active:bg-surface-active ${
                back ? "-ml-1.5 pl-1.5" : "pl-2"
              }`}
            >
              {heading}
            </Button>
          ) : title !== undefined ? (
            <div className={`flex min-w-0 flex-1 flex-col ${back ? "" : "pl-2"}`}>{heading}</div>
          ) : (
            <div className="flex-1" />
          )}
          {trailing}
        </div>
      </div>
    </header>
  );
}

/** A status's mark, in a fixed box so the text after it never moves sideways. */
export function StatusMarkView({ status }: { status: ShownStatus }) {
  const mark = statusMark(status);
  if (mark === undefined) return null;
  return (
    <span aria-hidden className="grid size-3 shrink-0 place-items-center">
      {mark.kind === "dot" ? (
        <span className={mark.className} />
      ) : (
        <mark.icon size={11} strokeWidth={1.75} className={mark.className} />
      )}
    </span>
  );
}

/**
 * The CompactBar subtitle for a connection status, or `live` while it's live, with the key to swap
 * between them: pass both to `CompactBar` as `subtitle` and `subtitleKey`.
 */
export function connectionLine(
  status: ShownStatus,
  live: ReactNode,
): { readonly subtitle: ReactNode; readonly subtitleKey: string } {
  const text = connectionSubtitle(status);
  if (text === undefined) return { subtitle: live, subtitleKey: "live" };
  return {
    subtitle: (
      <>
        <StatusMarkView status={status} />
        <span className="min-w-0 truncate">{text}</span>
      </>
    ),
    // Details such as a later "last seen" update in place rather than crossfading.
    subtitleKey: status.kind,
  };
}
