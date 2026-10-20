import { Collapsible } from "@base-ui/react/collapsible";
import type { TodoItem } from "@cerium/protocol";
import { Check, ChevronRight, Circle, X } from "lucide-react";
import { useState } from "react";

import { currentText, planProgress } from "./planProgress.ts";

const tick: Record<TodoItem["status"], string> = {
  completed: "bg-success",
  inProgress: "bg-running",
  pending: "bg-line-strong",
  cancelled: "bg-line-subtle",
};

/**
 * An agent's todo list or plan: how far along it is and what it is doing now, folded until asked
 * for the whole list. It follows the harness live, so items move from waiting to working to done as
 * the agent reports them.
 */
export function Plan({
  items,
  working,
  explanation,
}: {
  readonly items: ReadonlyArray<TodoItem>;
  /** The agent is mid-turn: an item in progress is being worked on, rather than left over. */
  readonly working: boolean;
  /** Why the agent changed its plan, when the harness said. */
  readonly explanation?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const progress = planProgress(items);
  const now = currentText(progress);
  const settled = progress.completed + progress.cancelled;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="flex flex-col gap-1.5">
      <Collapsible.Trigger className="group -mx-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-[13px] text-fg-secondary transition-colors select-none hover:text-fg-primary data-panel-open:text-fg-primary max-md:py-2">
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-medium">Plan</span>
        <span className="ml-auto text-xs text-fg-tertiary tabular-nums max-md:text-[13px]">
          {progress.finished ? "Done" : `${settled} of ${progress.total}`}
        </span>
      </Collapsible.Trigger>

      <div aria-hidden="true" className="flex h-1 gap-px overflow-hidden rounded-full">
        {items.map((item, index) => (
          <span
            key={item.id ?? index}
            className={`min-w-px flex-1 transition-colors duration-300 ${tick[item.status]} ${
              item.status === "inProgress" && working ? "animate-pulse motion-reduce:animate-none" : ""
            }`}
          />
        ))}
      </div>

      {open || now === undefined ? null : (
        <p className="truncate text-[12.5px] text-fg-secondary max-md:text-[14px]" title={now}>
          {progress.active ? null : <span className="text-fg-tertiary">Next: </span>}
          {now}
        </p>
      )}

      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        {explanation ? (
          <p className="pb-1.5 text-xs text-fg-tertiary max-md:text-[13px]">{explanation}</p>
        ) : null}
        <ol aria-label="Plan items" className="flex flex-col gap-1 pb-0.5">
          {items.map((item, index) => (
            <PlanItem key={item.id ?? index} item={item} working={working} />
          ))}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function PlanItem({ item, working }: { item: TodoItem; working: boolean }) {
  const active = item.status === "inProgress";
  return (
    <li className="flex items-start gap-2 text-[12.5px] leading-[1.45] max-md:text-[14px]">
      <span className="mt-[3px] grid size-3.5 shrink-0 place-items-center max-md:mt-1">
        {item.status === "completed" ? (
          <Check size={13} strokeWidth={2.5} className="text-success" />
        ) : item.status === "cancelled" ? (
          <X size={12} strokeWidth={2} className="text-fg-disabled" />
        ) : active ? (
          <span className="relative grid size-2 place-items-center">
            {working ? <span className="absolute size-2 animate-ping rounded-full bg-running/45" /> : null}
            <span className="size-1.5 rounded-full bg-running" />
          </span>
        ) : (
          <Circle size={10} strokeWidth={1.75} className="text-fg-tertiary" />
        )}
      </span>
      <span
        className={`min-w-0 break-words select-text ${
          active
            ? "text-fg-primary"
            : item.status === "completed"
              ? "text-fg-tertiary"
              : item.status === "cancelled"
                ? "text-fg-disabled line-through"
                : "text-fg-secondary"
        }`}
      >
        {active ? (item.activeText ?? item.text) : item.text}
      </span>
    </li>
  );
}
