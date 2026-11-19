import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { HISTORY_EVENT } from "./HistoryWindow.tsx";
import { Took } from "./Trace.tsx";
import { summarizeTools, type ToolBlock } from "./tools.ts";
import type { Timing } from "./ToolGroup.tsx";

/**
 * The reader's choice to open or close a run or work. Work remembers by its last step, which stays
 * the same when loading history changes its first step.
 */
export const WorkToggles = createContext(new Map<string, boolean>());

/** If a folding section holds focus, return it to the section's trigger. */
export function useWorkFocus(open: boolean) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open && panel.current?.contains(document.activeElement)) {
      trigger.current?.focus({ preventScroll: true });
    }
  }, [open]);
  return { trigger, panel };
}

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
  headerClass = "",
  headerStyle,
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
  headerClass?: string;
  headerStyle?: CSSProperties | undefined;
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
  const { trigger, panel } = useWorkFocus(open);
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
        ref={trigger}
        className={`group flex max-w-full min-w-0 items-center gap-2 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary max-md:py-1 ${headerClass}`}
        style={headerStyle}
      >
        <span className="work-label grid shrink-0 font-medium" data-working={live}>
          <span aria-hidden={!live} className="text-shimmer col-start-1 row-start-1">
            Working
          </span>
          <span
            aria-hidden={live}
            className="col-start-1 row-start-1 text-fg-secondary group-hover:text-fg-primary"
          >
            Worked
          </span>
        </span>
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
      <Collapsible.Panel
        ref={panel}
        className="work-fold h-(--collapsible-panel-height) overflow-hidden data-ending-style:h-0 data-starting-style:h-0"
      >
        <div className="mt-2 ml-1.5 flex flex-col gap-3 border-l border-line-subtle pb-1 pl-4">
          {children}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
