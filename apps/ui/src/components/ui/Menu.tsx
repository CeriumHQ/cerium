import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

// Cerium-styled parts over Base UI's Menu.

export const MenuRoot = BaseMenu.Root;

/** Renders `children` (a single focusable element) as the menu's trigger. */
export function MenuTrigger({ children }: { children: ReactElement }) {
  return <BaseMenu.Trigger render={children} />;
}

const popupClass =
  "min-w-40 origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";

const itemClass =
  "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none select-none data-disabled:opacity-40 data-highlighted:bg-surface-hover";

export function MenuPopup({
  children,
  side = "bottom",
  align = "end",
}: {
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={4} className="z-50 outline-none">
        <BaseMenu.Popup className={popupClass}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  shortcut,
  tone = "default",
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** The item's keyboard shortcut, shown on the right, such as "Ctrl C". */
  shortcut?: string;
  tone?: "default" | "danger";
}) {
  return (
    <BaseMenu.Item
      {...(onClick ? { onClick } : {})}
      {...(disabled ? { disabled } : {})}
      className={`${itemClass} ${
        tone === "danger"
          ? "text-error data-highlighted:text-error"
          : "text-fg-secondary data-highlighted:text-fg-primary"
      }`}
    >
      {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
      {children}
      {shortcut ? <kbd className="ml-auto pl-6 font-sans text-2xs text-fg-tertiary">{shortcut}</kbd> : null}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-2 my-1 h-px bg-line-subtle" />;
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.GroupLabel className="px-2 pt-1.5 pb-1 text-2xs font-medium text-fg-tertiary select-none">
      {children}
    </BaseMenu.GroupLabel>
  );
}

/** One choice of a `BaseMenu.RadioGroup`, ticked while it's the group's value. */
export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseMenu.RadioItem
      value={value}
      closeOnClick
      className={`${itemClass} relative pr-7 text-fg-secondary data-checked:text-fg-primary data-highlighted:text-fg-primary`}
    >
      {children}
      <BaseMenu.RadioItemIndicator className="absolute right-2 text-fg-secondary">
        <Check size={14} strokeWidth={2} />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

export const MenuRadioGroup = BaseMenu.RadioGroup;

/**
 * Where an item of the open context menu sent focus, such as the message box. The menu takes focus
 * back while it closes, then hands it there rather than to its trigger.
 */
let movedFocus: HTMLElement | undefined;

const trackFocus = (event: FocusEvent) => {
  if (event.target instanceof HTMLElement && event.target.closest("[role=menu]") === null)
    movedFocus = event.target;
};

const watchFocus = (open: boolean) => {
  if (!open) return;
  movedFocus = undefined;
  document.addEventListener("focusin", trackFocus);
};

const finalFocus = () => {
  document.removeEventListener("focusin", trackFocus);
  const target = movedFocus;
  movedFocus = undefined;
  return target?.isConnected ? target : true;
};

/** A menu that opens at the pointer when `children` (a single element) is right-clicked. */
export function ContextMenuArea({ children, menu }: { children: ReactElement; menu: ReactNode }) {
  return (
    <ContextMenu.Root onOpenChange={watchFocus}>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup finalFocus={finalFocus} className={popupClass}>
            {menu}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A point in the window, in CSS pixels. */
export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A menu that opens at `point` rather than at a trigger, placed like `ContextMenuArea`'s: for a
 * right-click reported from outside the page. It leaves focus alone as it closes, for the caller to
 * put back.
 */
export function PointMenu({
  point,
  open,
  onOpenChange,
  children,
}: {
  point: MenuPoint;
  open: boolean;
  onOpenChange: (open: boolean, details: BaseMenu.Root.ChangeEventDetails) => void;
  children: ReactNode;
}) {
  const anchor = {
    getBoundingClientRect: () => DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
  };
  return (
    <BaseMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          anchor={anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={-5}
          alignOffset={2}
          className="z-50 outline-none"
        >
          <BaseMenu.Popup finalFocus={false} className={popupClass}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
