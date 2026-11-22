import { Drawer } from "@base-ui/react/drawer";
import type { ComponentProps, ReactNode, RefObject } from "react";

// A sheet that rises from the bottom of a phone's screen, over a scrim: dragged down past a third of
// its height (or flicked) it goes, Esc and the scrim close it too. It sits on the part of the page
// that shows (web/viewport.ts), so a field in it stays above the keyboard. Under reduced motion it
// fades rather than slides.

const backdropClass =
  "fixed inset-0 bg-scrim opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-200 ease-out-soft data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-150 data-ending-style:ease-in-soft supports-[-webkit-touch-callout:none]:absolute";

const viewportClass =
  "fixed inset-x-0 top-[var(--app-top,0px)] flex h-[var(--app-height,100dvh)] items-end justify-center outline-none";

const popupClass = [
  "relative flex max-h-[calc(var(--app-height,100dvh)*0.85)] w-full max-w-lg flex-col rounded-t-[20px] border-t border-line-strong bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl outline-none",
  "px-[max(env(safe-area-inset-left),0.75rem)] pb-[max(env(safe-area-inset-bottom),0.75rem)]",
  // Follows the finger as it's dragged, and springs from wherever it was let go.
  "[transform:translateY(var(--drawer-swipe-movement-y,0px))] transition-[transform,opacity] duration-300 ease-out-soft data-swiping:duration-0 data-swiping:select-none",
  "data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*200ms)] data-ending-style:ease-in-soft",
  "motion-reduce:data-starting-style:[transform:none] motion-reduce:data-starting-style:opacity-0 motion-reduce:data-ending-style:[transform:translateY(var(--drawer-swipe-movement-y,0px))] motion-reduce:data-ending-style:opacity-0",
].join(" ");

export interface SheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What the sheet is, read out when it opens; shown as its heading unless `hideTitle`. */
  readonly title: string;
  readonly hideTitle?: boolean;
  /** What stays under the scrolling body: a button that acts on the sheet. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly initialFocus?: boolean | RefObject<HTMLElement | null>;
  readonly finalFocus?: boolean | RefObject<HTMLElement | null>;
  /** Called once it has finished opening or closing. */
  readonly onOpenChangeComplete?: (open: boolean) => void;
}

/** A bottom sheet, controlled: the Thread sheet, the triage and Later lists, a paste box. */
export function Sheet({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  footer,
  children,
  initialFocus,
  finalFocus,
  onOpenChangeComplete,
}: SheetProps) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      {...(onOpenChangeComplete ? { onOpenChangeComplete } : {})}
    >
      <Drawer.Portal>
        <Drawer.Backdrop className={backdropClass} />
        <Drawer.Viewport className={viewportClass}>
          <Drawer.Popup
            data-sheet=""
            className={popupClass}
            {...(initialFocus === undefined ? {} : { initialFocus })}
            {...(finalFocus === undefined ? {} : { finalFocus })}
          >
            <div
              aria-hidden="true"
              className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-line-strong"
            />
            <Drawer.Title
              className={
                hideTitle ? "sr-only" : "shrink-0 px-3 pt-2 pb-1 text-[15px] font-semibold tracking-tight"
              }
            >
              {title}
            </Drawer.Title>
            <Drawer.Content className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {children}
            </Drawer.Content>
            {footer === undefined ? null : <div className="shrink-0 pt-2">{footer}</div>}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** A titled group of a sheet's rows. */
export function SheetSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-3 pt-3 pb-1.5 text-meta font-medium text-fg-tertiary">{title}</h3>
      {children}
    </section>
  );
}

/** A sheet row's class, for a row that renders through another element. */
export const sheetRowClass =
  "flex h-12 w-full shrink-0 items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg-primary outline-none select-none transition-colors active:bg-surface-active focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50";

/** One tappable row of a sheet: its icon, its words, and what trails them. `closes` closes the sheet too. */
export function SheetRow({
  icon,
  trailing,
  closes = false,
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "className"> & {
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly closes?: boolean;
  readonly className?: string;
}) {
  const content = (
    <>
      {icon === undefined ? null : (
        <span className="grid size-5 shrink-0 place-items-center text-fg-secondary">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1.5 text-fg-tertiary">{trailing}</span>
      )}
    </>
  );
  const rowClass = `${sheetRowClass} ${className ?? ""}`;
  return closes ? (
    <Drawer.Close {...props} className={rowClass}>
      {content}
    </Drawer.Close>
  ) : (
    <button type="button" {...props} className={rowClass}>
      {content}
    </button>
  );
}

/** Closes the sheet it's in. */
export const SheetClose = Drawer.Close;
