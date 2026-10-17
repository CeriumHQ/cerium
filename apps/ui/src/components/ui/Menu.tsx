import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

// Cerium-styled parts over Base UI's Menu.

export const MenuRoot = BaseMenu.Root;

/** Renders `children` (a single focusable element) as the menu's trigger. */
export function MenuTrigger({ children }: { children: ReactElement }) {
  return <BaseMenu.Trigger render={children} />;
}

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
        <BaseMenu.Popup className="min-w-40 origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <BaseMenu.Item
      {...(onClick ? { onClick } : {})}
      {...(disabled ? { disabled } : {})}
      className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none select-none data-disabled:opacity-40 data-highlighted:bg-surface-hover ${
        tone === "danger"
          ? "text-error data-highlighted:text-error"
          : "text-fg-secondary data-highlighted:text-fg-primary"
      }`}
    >
      {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
      {children}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-2 my-1 h-px bg-line-subtle" />;
}
