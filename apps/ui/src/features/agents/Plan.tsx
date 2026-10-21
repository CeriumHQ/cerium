import type { TodoItem } from "@cerium/protocol";
import { Check, Circle, X } from "lucide-react";
import type { ReactNode } from "react";

import { planProgress } from "./planProgress.ts";

/**
 * An agent's todo list or plan as a timeline, following the harness live as items move from waiting
 * to working to done. What the agent last said sits under the step it is on, or under the last one
 * once the plan is done.
 */
export function Plan({
  items,
  working,
  explanation,
  children,
}: {
  readonly items: ReadonlyArray<TodoItem>;
  /** The agent is mid-turn: an item in progress is being worked on, rather than left over. */
  readonly working: boolean;
  /** Why the agent changed its plan, when the harness said. */
  readonly explanation?: string | undefined;
  /** The agent's latest words, placed under the step they belong to. */
  readonly children?: ReactNode;
}) {
  if (items.length === 0) return null;
  const progress = planProgress(items);
  const anchor = progress.current ?? items.at(-1);
  const settled = progress.completed + progress.cancelled;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center text-2xs text-fg-tertiary max-md:text-xs">
        <span>Plan</span>
        <span className="ml-auto tabular-nums">
          {progress.finished ? "Done" : `${settled} of ${progress.total}`}
        </span>
      </div>
      {explanation ? <p className="text-xs text-fg-tertiary max-md:text-[13px]">{explanation}</p> : null}
      <ol aria-label="Plan items" className="flex flex-col">
        {items.map((item, index) => (
          <Step key={item.id ?? index} item={item} working={working} last={index === items.length - 1}>
            {item === anchor ? children : null}
          </Step>
        ))}
      </ol>
    </div>
  );
}

function Step({
  item,
  working,
  last,
  children,
}: {
  item: TodoItem;
  working: boolean;
  last: boolean;
  children: ReactNode;
}) {
  const active = item.status === "inProgress";
  return (
    <li className={`relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 ${last ? "" : "pb-2.5"}`}>
      {/* The rail runs from under this step's mark to the top of the next one's. */}
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-[19px] -bottom-[3px] left-[6.5px] w-px bg-line-strong max-md:top-5 max-md:-bottom-1"
        />
      )}
      <span className="mt-[3px] grid size-3.5 place-items-center max-md:mt-1">
        {item.status === "completed" ? (
          <Check size={13} strokeWidth={2.5} className="text-success" />
        ) : item.status === "cancelled" ? (
          <X size={12} strokeWidth={2} className="text-fg-disabled" />
        ) : active ? (
          <span className="relative grid size-2 place-items-center">
            {working ? (
              <span className="absolute size-2 animate-ping rounded-full bg-running/45 motion-reduce:animate-none" />
            ) : null}
            <span className="size-1.5 rounded-full bg-running" />
          </span>
        ) : (
          <Circle size={10} strokeWidth={1.75} className="text-fg-tertiary" />
        )}
      </span>
      <div className="min-w-0">
        <p
          className={`text-[12.5px] leading-[1.45] break-words select-text max-md:text-[14px] ${
            active
              ? "font-medium text-fg-primary"
              : item.status === "completed"
                ? "text-fg-tertiary"
                : item.status === "cancelled"
                  ? "text-fg-disabled line-through"
                  : "text-fg-secondary"
          }`}
        >
          {active ? (item.activeText ?? item.text) : item.text}
        </p>
        {children ? <div className="mt-1.5">{children}</div> : null}
      </div>
    </li>
  );
}
