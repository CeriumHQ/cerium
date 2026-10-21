import type { GitFileChange, GitStatus } from "@cerium/rpc";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { StateLetter } from "../files/FileStatus.tsx";
import { changeRows, dirOf, type ChangeGroup, type ChangeRow } from "./model.ts";

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
 * What changed in the repository, in three lists: what a merge left to settle, what's staged for the
 * next commit, and what isn't, new files included. Each is a tree of the folders its files are in.
 */
export function ChangesView({
  status,
  error,
  activePath,
  onOpen,
  children,
}: {
  status: GitStatus | undefined;
  /** The status couldn't be read, in words for the user. */
  error: string | undefined;
  /** The file the viewer shows, marked in the lists. */
  activePath: string | undefined;
  onOpen: OpenChange | undefined;
  /** The commit box, above the lists. */
  children?: ReactNode;
}) {
  if (status === undefined) {
    return error === undefined ? null : <Empty>{error}</Empty>;
  }
  if (!status.repository) {
    return <Empty>This folder isn't in a git repository.</Empty>;
  }
  const empty = status.staged.length + status.unstaged.length + status.conflicted.length === 0;
  return (
    <div className="flex flex-col pb-2">
      {children}
      {empty ? <Empty>Nothing to commit: everything matches the last commit.</Empty> : null}
      {(["conflicted", "staged", "unstaged"] as const).map((group) =>
        status[group].length === 0 ? null : (
          <Group key={group} group={group} changes={status[group]} activePath={activePath} onOpen={onOpen} />
        ),
      )}
      {status.truncated === true ? (
        <p className="px-4 pt-2 text-[12px] text-fg-tertiary">More files changed than are listed here.</p>
      ) : null}
    </div>
  );
}

function Group({
  group,
  changes,
  activePath,
  onOpen,
}: {
  group: ChangeGroup;
  changes: ReadonlyArray<GitFileChange>;
  activePath: string | undefined;
  onOpen: OpenChange | undefined;
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
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 w-full cursor-default items-center gap-1 rounded-md px-1 text-left text-[11.5px] font-semibold tracking-wide text-fg-tertiary uppercase outline-none select-none hover:text-fg-secondary focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:h-10 max-md:text-[13px]"
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          <span>{groupTitle[group]}</span>
          <span className="ml-1 font-medium tabular-nums">{changes.length}</span>
        </button>
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
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Row({ row, active, onActivate }: { row: ChangeRow; active: boolean; onActivate: () => void }) {
  const file = row.kind === "file" ? row.change : undefined;
  const gone = file?.state === "deleted";
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-expanded={row.kind === "folder" ? !row.collapsed : undefined}
      onClick={onActivate}
      style={{ paddingLeft: 4 + row.depth * INDENT }}
      className="flex h-7 w-full cursor-default items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-fg-primary outline-none select-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset aria-[current=page]:bg-surface-selected max-md:h-11 max-md:text-[14px]"
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
        <span className={`min-w-0 truncate ${gone ? "text-fg-tertiary line-through" : ""}`}>{row.label}</span>
        {file?.from === undefined ? null : (
          <span className="min-w-0 truncate text-fg-tertiary">
            from{" "}
            {dirOf(file.from) === dirOf(file.path)
              ? file.from.slice(file.from.lastIndexOf("/") + 1)
              : file.from}
          </span>
        )}
      </span>
      {row.kind === "folder" ? (
        <span className="shrink-0 text-[11.5px] text-fg-tertiary tabular-nums">{row.count}</span>
      ) : (
        <StateLetter state={row.change.state} />
      )}
    </button>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-6 text-center text-[13px] text-balance text-fg-tertiary max-md:text-[14px]">
    {children}
  </p>
);
