import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IssueFilters } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Check, ListFilter } from "lucide-react";
import { useState, type ReactNode } from "react";

import { issueChoicesAtom } from "../../backend/issues.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { LabelChip } from "../github/parts.tsx";
import { filterCount, isFiltered, toggleLabel, withMilestone } from "./model.ts";

const toggleClass =
  "flex-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary";

const rowClass =
  "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-primary outline-none select-none hover:bg-surface-hover focus-visible:bg-surface-hover";

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="px-2 pt-2 pb-1 text-2xs font-medium text-fg-tertiary">{children}</h3>;
}

/** A line the user can tick: a check in a small box, then what it stands for. */
function Tick({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={rowClass}>
      <Checkbox.Root
        checked={checked}
        onCheckedChange={onChange}
        className="grid size-4 shrink-0 place-items-center rounded border border-line-strong outline-none data-checked:border-transparent data-checked:bg-fg-primary data-checked:text-surface-panel"
      >
        <Checkbox.Indicator>
          <Check size={11} strokeWidth={2.5} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </label>
  );
}

/** A line the user can choose: a check beside the one that's chosen. */
function Choice({
  chosen,
  onChoose,
  children,
}: {
  chosen: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <button type="button" role="radio" aria-checked={chosen} onClick={onChoose} className={rowClass}>
      <span className="grid size-4 shrink-0 place-items-center">
        {chosen ? <Check size={13} strokeWidth={2} /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function FilterForm({
  cwd,
  filters,
  onChange,
}: {
  cwd: string;
  filters: IssueFilters;
  onChange: (filters: IssueFilters) => void;
}) {
  const choices = Option.getOrUndefined(AsyncResult.value(useAtomValue(issueChoicesAtom(cwd))));
  const chosenLabels = new Set(filters.labels ?? []);
  const milestone = filters.milestone ?? (filters.noMilestone === true ? "none" : undefined);
  const set = (patch: Partial<IssueFilters>): IssueFilters => ({ ...filters, ...patch });
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-2 pt-2">
        <ToggleGroup
          aria-label="State"
          value={[filters.state ?? "open"]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "open" || next === "closed" || next === "all") onChange(set({ state: next }));
          }}
          className="flex items-center rounded-lg bg-surface-sunken p-0.5"
        >
          <Toggle value="open" className={toggleClass}>
            Open
          </Toggle>
          <Toggle value="closed" className={toggleClass}>
            Closed
          </Toggle>
          <Toggle value="all" className={toggleClass}>
            All
          </Toggle>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-96">
        <div className="p-1">
          <Heading>People</Heading>
          <Tick
            checked={filters.assignedToMe === true}
            onChange={(on) => onChange(set({ assignedToMe: on }))}
          >
            Assigned to me
          </Tick>
          <Tick checked={filters.createdByMe === true} onChange={(on) => onChange(set({ createdByMe: on }))}>
            Created by me
          </Tick>
          <Tick
            checked={filters.mentioningMe === true}
            onChange={(on) => onChange(set({ mentioningMe: on }))}
          >
            Mentioning me
          </Tick>
          {choices === undefined || choices.labels.length === 0 ? null : (
            <>
              <Heading>Labels</Heading>
              {choices.labels.map((label) => (
                <Tick
                  key={label.name}
                  checked={chosenLabels.has(label.name)}
                  onChange={() => onChange(toggleLabel(filters, label.name))}
                >
                  <LabelChip label={label} />
                </Tick>
              ))}
            </>
          )}
          {choices === undefined || choices.milestones.length === 0 ? null : (
            <div role="radiogroup" aria-label="Milestone">
              <Heading>Milestone</Heading>
              <Choice
                chosen={milestone === undefined}
                onChoose={() => onChange(withMilestone(filters, undefined))}
              >
                Any
              </Choice>
              <Choice chosen={milestone === "none"} onChoose={() => onChange(withMilestone(filters, "none"))}>
                None
              </Choice>
              {choices.milestones.map((each) => (
                <Choice
                  key={each.title}
                  chosen={milestone === each.title}
                  onChoose={() => onChange(withMilestone(filters, each.title))}
                >
                  {each.title}
                </Choice>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      {isFiltered(filters) ? (
        <div className="shrink-0 border-t border-line-subtle p-1">
          <button
            type="button"
            onClick={() => onChange({})}
            className={`${rowClass} justify-center text-fg-secondary`}
          >
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The button that opens the issue filters, with the number of them that are set. */
export function IssueFilterMenu({
  cwd,
  filters,
  onChange,
}: {
  cwd: string;
  filters: IssueFilters;
  onChange: (filters: IssueFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = filterCount(filters);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label="Filter issues">
        <Popover.Trigger
          aria-label={count === 0 ? "Filter issues" : `Filter issues, ${count} set`}
          className="relative grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active data-popup-open:text-fg-primary max-md:size-10"
        >
          <ListFilter size={15} strokeWidth={1.75} />
          {count === 0 ? null : (
            <span className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-fg-primary px-0.5 text-[9px] font-semibold text-surface-panel tabular-nums">
              {count}
            </span>
          )}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup
            aria-label="Filter issues"
            className="flex max-h-(--available-height) w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <FilterForm cwd={cwd} filters={filters} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
