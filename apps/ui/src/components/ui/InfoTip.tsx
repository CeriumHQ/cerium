import { Tooltip } from "@base-ui/react/tooltip";
import { Info } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * A small "i" beside a label, holding the explanation the label doesn't need at a glance. Hovering or
 * keyboard-focusing it shows the text; a click or tap pins it open, so touch screens, which can't
 * hover, reach it too. Esc, another click, a click elsewhere or tabbing on puts it away.
 */
export function InfoTip({
  children,
  label = "More about this",
  side = "top",
  className,
}: {
  /** The explanation: a sentence or two. */
  children: ReactNode;
  /** The button's accessible name, such as "About access modes". */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Opened by a click or tap: it stays while the pointer wanders off, until it's dismissed. */
  const [pinned, setPinned] = useState(false);
  const popupId = useId();
  return (
    <Tooltip.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && pinned && details.reason === "trigger-hover") return;
        setOpen(next);
        if (!next) setPinned(false);
      }}
    >
      <Tooltip.Trigger
        // A tooltip normally goes away on a click; here the click is what keeps it.
        closeOnClick={false}
        delay={250}
        closeDelay={100}
        aria-label={label}
        // Read out with the button, as the text it opens.
        aria-describedby={open ? popupId : undefined}
        // A second click or tap puts a pinned tip away.
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
        // Focus moving on puts it away; a press inside the tip, to select its text, doesn't.
        onBlur={(event) => {
          if (event.relatedTarget === null) return;
          setPinned(false);
          setOpen(false);
        }}
        // The icon is small; the hit area around it isn't.
        className={`relative inline-grid size-4 shrink-0 place-items-center rounded-full align-[-0.2em] text-fg-tertiary transition-colors after:absolute after:-inset-1.5 hover:text-fg-secondary data-popup-open:text-fg-primary max-md:after:-inset-3 ${className ?? ""}`}
      >
        <Info size={13} strokeWidth={1.75} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={8} className="z-50">
          <Tooltip.Popup
            id={popupId}
            className="max-w-[min(18rem,calc(100vw-1rem))] origin-(--transform-origin) rounded-lg border border-line-subtle bg-surface-overlay px-3 py-2 text-meta leading-relaxed text-fg-secondary shadow-overlay backdrop-blur-xl transition-[opacity,scale] duration-150 ease-out-soft select-text data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 max-md:text-[13px]"
          >
            {children}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
