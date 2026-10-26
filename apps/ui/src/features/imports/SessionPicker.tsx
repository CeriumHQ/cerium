import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import type { PastSession } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, ChevronRight, Minus } from "lucide-react";
import { useState } from "react";

import { harnessesAtom, importedThreadsAtom, importSessions } from "../../backend/atoms.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { shortAgo } from "../../lib/time.ts";
import { accessLimit, allowedAccess } from "../composer/models.ts";
import { accessAtom } from "../settings/preferences.ts";
import { harnessName } from "../settings/Harnesses.tsx";
import {
  defaultPicks,
  groupByProject,
  groupPicked,
  recentSince,
  sessionKey,
  toggleGroup,
  toggleSession,
  type ProjectGroup,
} from "./model.ts";

export type ImportState =
  | { readonly _tag: "picking" }
  | { readonly _tag: "importing" }
  | { readonly _tag: "done"; readonly count: number }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Picking sessions and bringing them in: the recent ones ticked to begin with, each lead on the access
 * new threads start with (or Full access where its harness can't run that one), and the threads made
 * marked seen.
 */
export function useSessionImport(sessions: ReadonlyArray<PastSession>) {
  const [now] = useState(Date.now);
  const [chosen, setPicked] = useState<ReadonlySet<string>>();
  const picked = chosen ?? defaultPicks(sessions, now);
  const [state, setState] = useState<ImportState>({ _tag: "picking" });
  const run = useAtomSet(importSessions, { mode: "promise" });
  const markSeen = useAtomSet(importedThreadsAtom);
  const access = useAtomValue(accessAtom);
  const statuses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);

  const start = async () => {
    const chosenSessions = sessions.filter((session) => picked.has(sessionKey(session)));
    if (chosenSessions.length === 0) return;
    setState({ _tag: "importing" });
    try {
      const threads = await run({
        sessions: chosenSessions,
        access: allowedAccess(access, accessLimit(statuses, chosenSessions)),
        archiveBefore: recentSince(Date.now()),
      });
      markSeen(threads.map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt })));
      setState({ _tag: "done", count: threads.length });
    } catch (error) {
      setState({
        _tag: "failed",
        message: error instanceof Error && error.message !== "" ? error.message : "The import didn't finish.",
      });
    }
  };
  return { now, picked, setPicked, state, start };
}
export type SessionImport = ReturnType<typeof useSessionImport>;

/** The sessions as their projects, each a tick box over its sessions, which open beneath it. */
export function SessionPicker({
  sessions,
  picked,
  onPick,
  now,
  disabled = false,
  rowClassName = "",
}: {
  readonly sessions: ReadonlyArray<PastSession>;
  readonly picked: ReadonlySet<string>;
  readonly onPick: (picked: ReadonlySet<string>) => void;
  readonly now: number;
  readonly disabled?: boolean;
  /** Dresses each project's row, as the welcome's glass cards. */
  readonly rowClassName?: string;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {groupByProject(sessions, now).map((group) => (
        <li key={group.key}>
          <ProjectRow
            group={group}
            picked={picked}
            onPick={onPick}
            now={now}
            disabled={disabled}
            className={rowClassName}
          />
        </li>
      ))}
    </ul>
  );
}

function ProjectRow({
  group,
  picked,
  onPick,
  now,
  disabled,
  className,
}: {
  readonly group: ProjectGroup;
  readonly picked: ReadonlySet<string>;
  readonly onPick: (picked: ReadonlySet<string>) => void;
  readonly now: number;
  readonly disabled: boolean;
  readonly className: string;
}) {
  const state = groupPicked(group, picked);
  const count = group.sessions.length;
  return (
    <Collapsible.Root className={`rounded-xl border border-line-subtle ${className}`}>
      <div className="flex items-center gap-2.5 py-2 pr-2 pl-3">
        <Tick
          checked={state === "all"}
          indeterminate={state === "some"}
          disabled={disabled}
          onChange={() => onPick(toggleGroup(group, picked))}
          label={`Import ${group.name}`}
        />
        <Collapsible.Trigger className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-line-strong">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium text-fg-primary">{group.name}</span>
            <span className="truncate text-meta text-fg-tertiary">
              {group.recent === count
                ? `${count} recent`
                : `${count} ${count === 1 ? "session" : "sessions"}${group.recent > 0 ? ` · ${group.recent} recent` : ""}`}
              {group.cwd === undefined ? "" : ` · ${group.cwd}`}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {group.providers.map((provider) => (
              <ProviderLogo key={provider} provider={provider} size={13} className="text-fg-secondary" />
            ))}
          </span>
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
      </div>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <ul className="flex flex-col border-t border-line-subtle py-1">
          {group.sessions.map((session) => (
            <li key={sessionKey(session)} className="flex items-center gap-2.5 py-1 pr-3 pl-3">
              <Tick
                checked={picked.has(sessionKey(session))}
                disabled={disabled}
                onChange={() => onPick(toggleSession(session, picked))}
                label={`Import ${session.title}`}
              />
              <span
                className={`min-w-0 flex-1 truncate text-meta ${session.updatedAt >= recentSince(now) ? "text-fg-secondary" : "text-fg-tertiary"}`}
              >
                {session.title.trim() || "Untitled session"}
              </span>
              <span title={harnessName[session.provider]} className="shrink-0">
                <ProviderLogo provider={session.provider} size={11} className="text-fg-tertiary" />
              </span>
              <span className="w-7 shrink-0 text-right text-caption text-fg-tertiary tabular-nums">
                {shortAgo(session.updatedAt, now)}
              </span>
            </li>
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Tick({
  checked,
  indeterminate = false,
  disabled,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly disabled: boolean;
  readonly onChange: () => void;
  readonly label: string;
}) {
  return (
    <Checkbox.Root
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className="group grid size-4 shrink-0 place-items-center rounded-[5px] border border-line-strong outline-none transition-colors focus-visible:border-fg-secondary data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 data-indeterminate:border-accent data-indeterminate:bg-accent"
    >
      <Checkbox.Indicator keepMounted className="text-accent-fg data-unchecked:hidden">
        {indeterminate ? <Minus size={10} strokeWidth={3} /> : <Check size={10} strokeWidth={3} />}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
