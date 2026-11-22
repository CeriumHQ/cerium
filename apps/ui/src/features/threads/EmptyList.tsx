import type { ReactNode } from "react";

/** What a list with nothing in it yet says: what it will hold, in two short lines, and what to do about it. */
export function EmptyList({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  /** A way out of the emptiness, such as clearing the filter that caused it. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 pt-12 text-center">
      <p className="text-body font-medium text-fg-secondary max-md:text-[15px]">{title}</p>
      <p className="text-meta leading-relaxed text-fg-tertiary max-md:text-[13px]">{hint}</p>
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}
