import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** What a list with nothing in it yet says: what it will hold, in two short lines, and what to do about it. */
export function EmptyList({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  /** A way out of the emptiness, such as clearing the filter that caused it. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 pt-12 text-center">
      <span className="mb-2 grid size-9 place-items-center rounded-xl border border-line-subtle bg-surface-raised text-fg-tertiary shadow-raised">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <p className="text-body font-medium text-fg-secondary max-md:text-[15px]">{title}</p>
      <p className="text-meta leading-relaxed text-fg-tertiary max-md:text-[13px]">{hint}</p>
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}
