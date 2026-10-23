import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

import { keyLabel } from "../../lib/keys.ts";

export const TooltipProvider = BaseTooltip.Provider;

/** Other props go to the trigger, so another trigger (a context menu's) can render through this one. */
interface TooltipProps extends Omit<BaseTooltip.Trigger.Props, "render" | "children"> {
  readonly label: ReactNode;
  /** Keyboard shortcut shown after the label, spelled as lib/keys.ts reads it. */
  readonly shortcut?: string;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly children: ReactElement;
}

/** Wraps a single focusable element; the element is rendered as the trigger. */
export function Tooltip({ label, shortcut, side = "bottom", children, ...trigger }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger {...trigger} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup className="flex max-w-72 origin-(--transform-origin) items-center gap-2 rounded-md border border-line-subtle bg-surface-overlay px-2 py-1 text-xs text-fg-primary shadow-overlay backdrop-blur-xl transition-[opacity,scale] duration-150 ease-out-soft data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {label}
            {shortcut ? (
              <kbd className="font-sans text-2xs text-fg-tertiary">{keyLabel(shortcut)}</kbd>
            ) : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
