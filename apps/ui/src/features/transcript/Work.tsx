import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { createContext, use, useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { HISTORY_EVENT } from "./HistoryWindow.tsx";
import { Took } from "./Trace.tsx";
import { summarizeTools, type ToolBlock } from "./tools.ts";
import type { Timing } from "./ToolGroup.tsx";

/**
 * The reader's choice to open or close each work, by the last step it held then. A work's id is its
 * first step's, which changes when an earlier page of history loads above it; its later steps don't.
 */
export const WorkToggles = createContext(new Map<string, boolean>());

/**
 * Everything the agent did on a response before its final message, under one line: its calls, its
 * thoughts and what it said along the way. Open while the agent is on it, so its progress shows; it
 * folds once the response is over, unless the reader opened or closed it themselves. A find that
 * lands on a message inside opens it.
 */
export function WorkSection({
  tools,
  timings,
  live,
  arrived = false,
  stepIds,
  contains,
  children,
}: {
  /** Every call in the work, for the line's count of what it did. */
  tools: ReadonlyArray<ToolBlock>;
  /** Each step's, its thoughts' as well as its calls'. */
  timings: ReadonlyArray<Timing>;
  /** The agent is still on this work. */
  live: boolean;
  /** The work came in while the thread was open, so its line writes itself in. */
  arrived?: boolean;
  /** Its steps' ids, runs opened up, which remember the reader's choice. */
  stepIds: ReadonlyArray<string>;
  /** Whether a block of the conversation is inside, which a find looks for. */
  contains: (id: string) => boolean;
  children: ReactNode;
}) {
  const remembered = use(WorkToggles);
  const [toggled, setToggledState] = useState(() => {
    const id = stepIds.findLast((each) => remembered.has(each));
    return id === undefined ? undefined : remembered.get(id);
  });
  const setToggled = (value: boolean) => {
    setToggledState(value);
    const id = stepIds.at(-1);
    if (id !== undefined) remembered.set(id, value);
  };
  const open = toggled ?? live;
  const reveal = useEffectEvent((event: Event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id !== undefined && contains(id)) setToggled(true);
  });
  useEffect(() => {
    const listener = (event: Event) => reveal(event);
    window.addEventListener(HISTORY_EVENT, listener);
    return () => window.removeEventListener(HISTORY_EVENT, listener);
  }, []);
  const starts = timings.flatMap((step) => (step.startedAt === undefined ? [] : [step.startedAt]));
  const summary = summarizeTools(tools);
  return (
    <Collapsible.Root open={open} onOpenChange={setToggled}>
      <Collapsible.Trigger
        className={`group flex max-w-full min-w-0 items-center gap-2 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary max-md:py-1 ${arrived ? "write-in" : ""}`}
      >
        {live ? (
          <span className="shrink-0 text-shimmer font-medium">Working</span>
        ) : (
          <span className="shrink-0 font-medium text-fg-secondary transition-colors group-hover:text-fg-primary">
            Worked
          </span>
        )}
        {/* Once done, the turn's footer says how long it worked. */}
        {live && starts.length > 0 ? (
          <Took startedAt={Math.min(...starts)} endedAt={undefined} className="text-meta" />
        ) : null}
        {summary === "" ? null : <span className="min-w-0 truncate">{summary}</span>}
        <ChevronRight
          size={13}
          className="-ml-0.5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="mt-2 ml-1.5 flex flex-col gap-3 border-l border-line-subtle pb-1 pl-4">
          {children}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
