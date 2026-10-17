import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

// Cerium-styled parts over Base UI's Select. Compose them like Base UI's own anatomy.

export const SelectRoot = BaseSelect.Root;
export const SelectGroup = BaseSelect.Group;

/** A compact, quiet trigger for toolbars: content, then a small chevron. */
export function SelectTrigger({ children, label }: { children: ReactNode; label: string }) {
  return (
    <BaseSelect.Trigger
      aria-label={label}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors select-none hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary"
    >
      {children}
      <BaseSelect.Icon className="text-fg-tertiary">
        <ChevronDown size={12} strokeWidth={2} />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectPopup({ children }: { children: ReactNode }) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        side="top"
        sideOffset={6}
        alignItemWithTrigger={false}
        className="z-50 outline-none"
      >
        <BaseSelect.Popup className="max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <BaseSelect.List>{children}</BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectGroupLabel({ children }: { children: ReactNode }) {
  return (
    <BaseSelect.GroupLabel className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-2xs font-medium text-fg-tertiary">
      {children}
    </BaseSelect.GroupLabel>
  );
}

export function SelectItem({
  value,
  children,
  description,
  disabled,
}: {
  value: string;
  children: ReactNode;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <BaseSelect.Item
      value={value}
      {...(disabled ? { disabled } : {})}
      className="grid cursor-default grid-cols-[1fr_auto] items-center gap-x-6 rounded-lg px-2 py-1.5 text-[13px] text-fg-secondary outline-none select-none data-highlighted:bg-surface-hover data-highlighted:text-fg-primary data-selected:text-fg-primary data-disabled:opacity-40"
    >
      <span className="flex min-w-0 flex-col">
        <BaseSelect.ItemText className="truncate">{children}</BaseSelect.ItemText>
        {description ? <span className="truncate text-2xs text-fg-tertiary">{description}</span> : null}
      </span>
      <BaseSelect.ItemIndicator>
        <Check size={13} strokeWidth={2.25} />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export function SelectSeparator() {
  return <BaseSelect.Separator className="mx-2 my-1 h-px bg-line-subtle" />;
}
