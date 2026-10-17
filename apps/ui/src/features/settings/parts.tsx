import type { ReactNode } from "react";

import { ScrollArea } from "../../components/ui/ScrollArea.tsx";

/** A settings category: its title and what it covers, over its sections. Settles in when opened. */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-[42rem] flex-col gap-10 px-10 pt-12 pb-20 transition-[opacity,translate] duration-300 ease-out-soft starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-[20px] font-semibold tracking-tight text-fg-primary">{title}</h1>
          <p className="max-w-md text-[13px] leading-relaxed text-fg-tertiary">{description}</p>
        </header>
        {children}
      </div>
    </ScrollArea>
  );
}

/** Related settings under a heading, with room for an action on the right. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-[13.5px] font-medium text-fg-primary">{title}</h2>
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
      {keys.split(" ").map((key) => (
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
