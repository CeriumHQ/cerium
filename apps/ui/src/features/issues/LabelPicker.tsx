import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import type { GitHubLabel } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Check, LoaderCircle, Pencil, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

import { issueChoicesAtom } from "../../backend/issues.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { LabelChip } from "../github/parts.tsx";

/**
 * The repository's labels as a list to tick, filtered by what is typed: ticking one adds it to the
 * issue and unticking takes it off. Shared by the viewer, which changes the issue on each tick, and
 * the new-issue dialog, which keeps the choice until it creates the issue.
 */
export function LabelList({
  cwd,
  chosen,
  onToggle,
  disabled = false,
  maxHeight = "max-h-64",
}: {
  cwd: string;
  /** The names of the labels that are ticked. */
  chosen: ReadonlySet<string>;
  onToggle: (label: GitHubLabel, on: boolean) => void;
  disabled?: boolean;
  maxHeight?: string;
}) {
  const result = useAtomValue(issueChoicesAtom(cwd));
  const choices = Option.getOrUndefined(AsyncResult.value(result));
  const [search, setSearch] = useState("");
  if (choices === undefined) {
    return (
      <output className="grid place-items-center py-6 text-fg-tertiary" aria-label="Reading labels">
        {AsyncResult.isFailure(result) ? (
          <span className="text-body">The labels couldn't be read.</span>
        ) : (
          <LoaderCircle size={16} className="animate-spin" />
        )}
      </output>
    );
  }
  if (choices.labels.length === 0) {
    return <p className="px-3 py-4 text-center text-body text-fg-tertiary">This repository has no labels.</p>;
  }
  const needle = search.trim().toLowerCase();
  const shown =
    needle === ""
      ? choices.labels
      : choices.labels.filter((label) => label.name.toLowerCase().includes(needle));
  return (
    <div className="flex min-h-0 flex-col">
      {choices.labels.length < 8 ? null : (
        <label className="mx-2 mt-2 flex h-7 items-center gap-1.5 rounded-md bg-surface-sunken px-2 text-fg-tertiary focus-within:ring-1 focus-within:ring-focus-ring max-md:h-10">
          <Search size={13} strokeWidth={1.75} className="shrink-0" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter labels"
            aria-label="Filter labels"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-body text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
          />
        </label>
      )}
      <ScrollArea className="min-h-0 flex-1" viewportClassName={maxHeight}>
        <div className="p-1">
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-center text-body text-fg-tertiary">No label matches.</p>
          ) : (
            shown.map((label) => (
              <Row
                key={label.name}
                checked={chosen.has(label.name)}
                disabled={disabled}
                onChange={(on) => onToggle(label, on)}
              >
                <LabelChip label={label} />
              </Row>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Row({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-body text-fg-primary select-none hover:bg-surface-hover aria-disabled:opacity-60 max-md:py-2.5">
      <Checkbox.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="grid size-4 shrink-0 place-items-center rounded border border-line-strong outline-none focus-visible:ring-1 focus-visible:ring-focus-ring data-checked:border-transparent data-checked:bg-fg-primary data-checked:text-surface-panel"
      >
        <Checkbox.Indicator>
          <Check size={11} strokeWidth={2.5} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </label>
  );
}

/** A small button that opens the popover editing an issue's labels. */
export function LabelPicker({
  cwd,
  chosen,
  busy,
  onToggle,
}: {
  cwd: string;
  chosen: ReadonlySet<string>;
  /** An edit is in flight; ticks wait for it. */
  busy: boolean;
  onToggle: (label: GitHubLabel, on: boolean) => void;
}) {
  return (
    <Popover.Root>
      <Tooltip label="Edit labels">
        <Popover.Trigger
          aria-label="Edit labels"
          className="grid size-6 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active data-popup-open:text-fg-primary max-md:size-9"
        >
          <Pencil size={13} strokeWidth={1.75} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup
            aria-label="Labels"
            className="flex max-h-(--available-height) w-64 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <LabelList cwd={cwd} chosen={chosen} disabled={busy} onToggle={onToggle} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
