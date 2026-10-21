import type { GitFileChange, GitStatus } from "@cerium/rpc";
import { Button } from "@base-ui/react/button";
import { Check, ChevronRight, Minus, Plus, Undo2, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { StateLetter } from "../files/FileStatus.tsx";
import { changeRows, changesUnder, dirOf, type ChangeGroup, type ChangeRow } from "./model.ts";

/** Each row's indent per folder it's in. */
const INDENT = 14;

const groupTitle: Readonly<Record<ChangeGroup, string>> = {
  conflicted: "Conflicts",
  staged: "Staged",
  unstaged: "Changes",
};

/** Opens a changed file at what changed, from the repository's top. */
export type OpenChange = (change: GitFileChange, group: ChangeGroup) => void;

/**
 * What the lists do to the repository, each to the changes it's given. `where` names what a discard
 * covers: a folder, `""` for a whole list, undefined for one file.
 */
export interface ChangeActions {
  readonly stage: (changes: ReadonlyArray<GitFileChange>) => void;
  readonly unstage: (changes: ReadonlyArray<GitFileChange>) => void;
  readonly discard: (changes: ReadonlyArray<GitFileChange>, where: string | undefined) => void;
}

/**
 * What changed in the repository, in three lists: what a merge left to settle, what's staged for the
 * next commit, and what isn't, new files included. Each is a tree of the folders its files are in,
 * and a file, a folder or a whole list stages, unstages or discards from its row.
 */
export function ChangesView({
  status,
  error,
  activePath,
  activeGroup,
  onOpen,
  actions,
  onInit,
  children,
}: {
  status: GitStatus | undefined;
  /** The status couldn't be read, in words for the user. */
  error: string | undefined;
  /** The file the viewer shows, marked in the lists. */
  activePath: string | undefined;
  /** The list whose side of the file the viewer shows; without one, each list marks it. */
  activeGroup?: ChangeGroup | undefined;
  onOpen: OpenChange | undefined;
  actions: ChangeActions | undefined;
  /** Makes the folder a repository, where it isn't one; absent, the folder gets no button. */
  onInit?: (() => void) | undefined;
  /** The commit box, above the lists. */
  children?: ReactNode;
}) {
  if (status === undefined) {
    return error === undefined ? null : <Empty>{error}</Empty>;
  }
  if (!status.repository) {
    return (
      <div className="flex flex-col items-center gap-3 pb-6">
        {children}
        <p className="px-4 pt-6 text-center text-[13px] text-balance text-fg-tertiary max-md:text-[14px]">
          This folder isn't in a git repository.
        </p>
        {onInit === undefined ? null : (
          <Button
            onClick={onInit}
            className="h-8 rounded-lg border border-line-strong bg-surface-hover px-3 text-[13px] font-medium text-fg-primary transition-colors hover:bg-surface-active max-md:h-10 max-md:px-4 max-md:text-[15px]"
          >
            Initialize repository
          </Button>
        )}
      </div>
    );
  }
  const empty = status.staged.length + status.unstaged.length + status.conflicted.length === 0;
  return (
    <div className="flex flex-col pb-2">
      {children}
      {empty ? <Empty>Nothing to commit: everything matches the last commit.</Empty> : null}
      {(["conflicted", "staged", "unstaged"] as const).map((group) =>
        status[group].length === 0 ? null : (
          <Group
            key={group}
            group={group}
            changes={status[group]}
            activePath={activeGroup === undefined || activeGroup === group ? activePath : undefined}
            onOpen={onOpen}
            actions={actions}
          />
        ),
      )}
      {status.truncated === true ? (
        <p className="px-4 pt-2 text-[12px] text-fg-tertiary">More files changed than are listed here.</p>
      ) : null}
    </div>
  );
}

/** A quiet button on a row, shown while the row is hovered or focused. */
function RowAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <Button
        aria-label={label}
        onClick={onClick}
        className="grid size-6 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-active hover:text-fg-primary focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:outline-none max-md:size-9"
      >
        <Icon size={14} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** What a row of `group` offers for `changes`; `where` as `ChangeActions` takes it. */
function rowActions(
  group: ChangeGroup,
  changes: ReadonlyArray<GitFileChange>,
  where: string | undefined,
  actions: ChangeActions | undefined,
): ReactNode {
  if (actions === undefined || changes.length === 0) return null;
  const one = where === undefined;
  if (group === "conflicted") {
    return one ? (
      <RowAction icon={Check} label="Mark as settled" onClick={() => actions.stage(changes)} />
    ) : null;
  }
  if (group === "staged") {
    return (
      <RowAction
        icon={Minus}
        label={one ? "Unstage" : "Unstage all"}
        onClick={() => actions.unstage(changes)}
      />
    );
  }
  const fresh = one && changes[0]?.state === "untracked";
  return (
    <>
      <RowAction
        icon={Undo2}
        label={fresh ? "Delete" : one ? "Discard changes" : "Discard all"}
        onClick={() => actions.discard(changes, where)}
      />
      <RowAction icon={Plus} label={one ? "Stage" : "Stage all"} onClick={() => actions.stage(changes)} />
    </>
  );
}

const actionsClass =
  "hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex max-md:flex";

function Group({
  group,
  changes,
  activePath,
  onOpen,
  actions,
}: {
  group: ChangeGroup;
  changes: ReadonlyArray<GitFileChange>;
  activePath: string | undefined;
  onOpen: OpenChange | undefined;
  actions: ChangeActions | undefined;
}) {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = changeRows(changes, collapsed);
  const toggleFolder = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <section aria-label={groupTitle[group]} className="px-1.5 pt-1.5">
      <h3 className="group/row flex items-center pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 cursor-default items-center gap-1 rounded-md px-1 text-left text-[11.5px] font-semibold tracking-wide text-fg-tertiary uppercase outline-none select-none hover:text-fg-secondary focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:h-10 max-md:text-[13px]"
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          <span>{groupTitle[group]}</span>
          <span className="ml-1 font-medium tabular-nums">{changes.length}</span>
        </button>
        <span className={actionsClass}>{rowActions(group, changes, "", actions)}</span>
      </h3>
      {open ? (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={`${row.kind}:${row.path}`}>
              <Row
                row={row}
                active={row.kind === "file" && row.path === activePath}
                onActivate={() =>
                  row.kind === "folder" ? toggleFolder(row.path) : onOpen?.(row.change, group)
                }
                actions={
                  row.kind === "folder"
                    ? rowActions(group, changesUnder(changes, row.path), row.path, actions)
                    : rowActions(group, [row.change], undefined, actions)
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Row({
  row,
  active,
  onActivate,
  actions,
}: {
  row: ChangeRow;
  active: boolean;
  onActivate: () => void;
  actions: ReactNode;
}) {
  const file = row.kind === "file" ? row.change : undefined;
  const gone = file?.state === "deleted";
  return (
    <div
      className={`group/row flex h-7 items-center rounded-md pr-2 hover:bg-surface-hover max-md:h-11 ${active ? "bg-surface-selected hover:bg-surface-selected" : ""}`}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-expanded={row.kind === "folder" ? !row.collapsed : undefined}
        onClick={onActivate}
        style={{ paddingLeft: 4 + row.depth * INDENT }}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md pr-1 text-left text-[12.5px] text-fg-primary outline-none select-none focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:text-[14px]"
      >
        <span className="grid size-4 shrink-0 place-items-center text-fg-tertiary">
          {row.kind === "folder" ? (
            <ChevronRight
              size={13}
              strokeWidth={2}
              className={`transition-transform duration-150 ${row.collapsed ? "" : "rotate-90"}`}
            />
          ) : null}
        </span>
        <FileIcon path={row.path} folder={row.kind === "folder"} className="size-4" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={`min-w-0 truncate ${gone ? "text-fg-tertiary line-through" : ""}`}>
            {row.label}
          </span>
          {file?.from === undefined ? null : (
            <span className="min-w-0 truncate text-fg-tertiary">
              from{" "}
              {dirOf(file.from) === dirOf(file.path)
                ? file.from.slice(file.from.lastIndexOf("/") + 1)
                : file.from}
            </span>
          )}
        </span>
      </button>
      <span className={actionsClass}>{actions}</span>
      {row.kind === "folder" ? (
        <span className="min-w-4 shrink-0 text-right text-[11.5px] text-fg-tertiary tabular-nums">
          {row.count}
        </span>
      ) : (
        <span className="grid w-4 shrink-0 place-items-center">
          <StateLetter state={row.change.state} />
        </span>
      )}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-6 text-center text-[13px] text-balance text-fg-tertiary max-md:text-[14px]">
    {children}
  </p>
);
