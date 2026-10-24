import { Switch } from "@base-ui/react/switch";
import { useAtomValue } from "@effect/atom-react";
import { Monitor } from "lucide-react";
import { useId, type ReactNode } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { keyCaps } from "../../lib/keys.ts";

/**
 * A settings category: its title, a line on what it covers when the title doesn't say, and an action
 * for the whole page, over its sections. Settles in when opened. `perMachine` pages show the driven
 * machine's settings, and say which while it isn't this one.
 */
export function SettingsPage({
  title,
  description,
  action,
  perMachine = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  perMachine?: boolean;
  children: ReactNode;
}) {
  const driven = useAtomValue(machineAtom);
  const badge =
    perMachine && driven ? (
      <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-accent-soft px-2 text-[12px] font-medium text-fg-primary">
        <Monitor size={12} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">On {driven.name}</span>
      </span>
    ) : null;
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-[42rem] flex-col gap-8 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),2rem)] transition-[opacity,translate] md:gap-10 md:px-10 md:pt-12 md:pb-20 duration-300 ease-out-soft starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
        {/* The narrow window's top bar already names the page, so there the header may be empty. */}
        <header className={`flex flex-col gap-1.5 ${description || badge || action ? "" : "max-md:hidden"}`}>
          {/* The title is hidden there, so the row stays only for what sits beside it. */}
          <div className={`flex min-h-7 items-center gap-2.5 ${badge || action ? "" : "max-md:hidden"}`}>
            <h1 className="text-[20px] font-semibold tracking-tight text-fg-primary max-md:hidden">
              {title}
            </h1>
            {badge}
            {action ? <div className="ml-auto flex shrink-0 items-center">{action}</div> : null}
          </div>
          {description ? (
            <p className="max-w-md text-[13px] leading-relaxed text-fg-tertiary">{description}</p>
          ) : null}
        </header>
        {children}
      </div>
    </ScrollArea>
  );
}

/** Related settings under a heading, with a line under it when the heading needs one, and an action on the right. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-[13.5px] font-medium text-fg-primary">{title}</h2>
          {description ? (
            <p className="text-[12.5px] leading-relaxed text-fg-tertiary">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One setting inside a card: its name, a short line under it when the name isn't enough, and its
 * control on the right (a switch, a menu). `error` says why the last change didn't save. `control`
 * receives the id of the name, for a control with no label of its own.
 */
export function SettingsRow({
  label,
  hint,
  error,
  control,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  control: (labelledBy: string) => ReactNode;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div className={`flex min-h-12 items-center gap-4 px-4 py-2.5 ${className ?? ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="text-[13px] font-medium text-fg-primary">
          {label}
        </span>
        {hint ? <span className="text-xs leading-relaxed text-fg-tertiary">{hint}</span> : null}
        {error ? <span className="text-xs leading-relaxed text-error">{error}</span> : null}
      </div>
      {control(labelId)}
    </div>
  );
}

/** A card of settings rows, a hairline between each. */
export function SettingsList({ children }: { children: ReactNode }) {
  return <SettingsCard className="flex flex-col divide-y divide-line-subtle">{children}</SettingsCard>;
}

/** A small tag beside a heading, such as "Experimental". */
export function SettingsTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-line-subtle px-1.5 text-2xs font-normal text-fg-tertiary">
      {children}
    </span>
  );
}

/** A setting's on/off switch, named by the element `labelledBy` points at. */
export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled = false,
  labelledBy,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  labelledBy: string;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-labelledby={labelledBy}
      className="relative mt-0.5 flex h-5 w-9 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel data-checked:bg-accent data-disabled:opacity-40"
    >
      <Switch.Thumb className="size-4 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-4 data-checked:bg-accent-fg" />
    </Switch.Root>
  );
}

/** A bordered card that groups settings or previews. */
export function SettingsCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border border-line-subtle ${className ?? ""}`}>{children}</div>;
}

/** A keyboard key, or a combination of them, drawn as keycaps that can be shown pressed. */
export function Keys({
  keys,
  size = "md",
  pressed = false,
}: {
  keys: string;
  size?: "sm" | "md";
  pressed?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keyCaps(keys).map((key) => (
        <kbd
          key={key}
          className={`grid place-items-center rounded-md border font-sans font-medium transition-[translate,border-width,background-color,color] duration-100 ${
            size === "sm" ? "h-5 min-w-5 px-1 text-2xs" : "h-6 min-w-6 px-1.5 text-xs"
          } ${
            pressed
              ? "translate-y-px border-b border-accent bg-accent text-accent-fg"
              : "border-b-2 border-line-strong bg-surface-raised text-fg-secondary"
          }`}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
