import { Button } from "@base-ui/react/button";
import type { TurnFile } from "@cerium/protocol";
import { Redo2, SquareTerminal, Undo2 } from "lucide-react";
import { useState } from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { dirOf, nameOf } from "../files/model.ts";
import type { TurnChanges as Changes } from "./model.ts";

// The files a turn changed, under its response: what changed and by how much, each opening its diff
// in a tab of its own, and the turn's changes undone (or redone) in one go. Files a command changed
// are found from the folder's snapshots, and marked, since no edit tool named them.

/** Rows shown before the rest fold behind "more". */
const SHOWN = 4;

/** A file of a turn, as the window opens its diff: the snapshots it lies between, and its path. */
export interface TurnFileOpen {
  readonly before: string;
  readonly after: string;
  readonly path: string;
}

export interface TurnFileActions {
  readonly open: (file: TurnFileOpen) => void;
  /** Resolves whether it worked; the turn's events then say what became of the files. */
  readonly revert: (turnId: string, direction: "undone" | "redone") => Promise<boolean>;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function Lines({ added, removed }: { added: number | undefined; removed: number | undefined }) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span className="shrink-0 text-meta tabular-nums">
      {added ? <span className="text-success">+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span className="text-error">−{removed}</span> : null}
    </span>
  );
}

const changeTag: Partial<Record<TurnFile["change"], string>> = { added: "new", deleted: "deleted" };

function Row({
  file,
  kept,
  undone,
  onOpen,
}: {
  file: TurnFile;
  kept: boolean;
  undone: boolean;
  onOpen: (() => void) | undefined;
}) {
  const dir = dirOf(file.path);
  const gone = file.change === "deleted";
  const tag = kept ? "kept" : changeTag[file.change];
  return (
    <li className="border-t border-line-subtle first:border-t-0">
      <Button
        onClick={onOpen}
        disabled={onOpen === undefined}
        title={file.path}
        className="flex h-8 w-full min-w-0 cursor-default items-center gap-2 px-3 text-left text-body outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:hover:bg-transparent max-md:h-10"
      >
        <FileIcon path={file.path} className={`size-4 shrink-0 ${undone && !kept ? "opacity-60" : ""}`} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={`max-w-full shrink-0 truncate ${
              gone || (undone && !kept) ? "text-fg-tertiary" : "text-fg-primary"
            } ${gone ? "line-through" : ""}`}
          >
            {nameOf(file.path)}
          </span>
          {dir === "" ? null : <span className="min-w-0 truncate text-meta text-fg-tertiary">{dir}</span>}
        </span>
        {file.via === "command" ? (
          <Tooltip label="Changed by a command" side="top">
            <span className="grid shrink-0 place-items-center text-fg-tertiary">
              <SquareTerminal size={13} strokeWidth={1.75} aria-label="Changed by a command" />
            </span>
          </Tooltip>
        ) : null}
        {tag === undefined ? null : (
          <span
            className={`shrink-0 rounded border px-1 text-[10.5px] leading-4 ${
              kept ? "border-warning/40 text-warning" : "border-line-subtle text-fg-tertiary"
            }`}
            title={kept ? "Changed since, so left as it is" : undefined}
          >
            {tag}
          </span>
        )}
        <Lines added={file.added} removed={file.removed} />
      </Button>
    </li>
  );
}

/** The files a turn changed, as a short list under its response. */
export function TurnChanges({
  changes,
  actions,
}: {
  changes: Changes;
  /** Without them (a version the conversation replaced, a thread read from the cloud), it only lists. */
  actions: TurnFileActions | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const { files, more, undone } = changes;
  const total = files.length + more;
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  // One row past the limit shows rather than a "1 more" that takes as much room.
  const shown = expanded || files.length <= SHOWN + 1 ? files : files.slice(0, SHOWN);
  const hidden = files.length - shown.length;
  const kept = new Set(undone?.kept ?? []);
  const direction = undone === undefined ? "undone" : "redone";

  const revert = async () => {
    if (actions === undefined || busy) return;
    setBusy(true);
    await actions.revert(changes.turnId, direction);
    setBusy(false);
  };

  return (
    <section
      aria-label="Files this turn changed"
      className="overflow-hidden rounded-lg border border-line-subtle text-fg-primary"
    >
      <header className="flex min-h-9 items-center gap-2.5 border-b border-line-subtle py-1 pr-1.5 pl-3">
        <h3 className="text-body font-medium">{plural(total, "file")} changed</h3>
        <Lines added={added || undefined} removed={removed || undefined} />
        {undone === undefined ? null : <span className="text-meta text-fg-tertiary">· undone</span>}
        <span className="flex-1" />
        {actions === undefined ? null : (
          <Tooltip
            label={
              undone === undefined
                ? "Put these files back as they were before this turn"
                : "Put back what this turn changed"
            }
            side="top"
          >
            <Button
              onClick={revert}
              disabled={busy}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-primary disabled:opacity-60 max-md:h-9"
            >
              {undone === undefined ? (
                <Undo2 size={13} strokeWidth={1.75} />
              ) : (
                <Redo2 size={13} strokeWidth={1.75} />
              )}
              {undone === undefined ? "Undo" : "Redo"}
            </Button>
          </Tooltip>
        )}
      </header>
      <ul>
        {shown.map((file) => (
          <Row
            key={file.path}
            file={file}
            kept={kept.has(file.path)}
            undone={undone !== undefined}
            onOpen={
              actions === undefined
                ? undefined
                : () => actions.open({ before: changes.before, after: changes.after, path: file.path })
            }
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <Button
          onClick={() => setExpanded(true)}
          className="flex h-8 w-full cursor-default items-center border-t border-line-subtle px-3 text-left text-meta text-fg-tertiary outline-none hover:bg-surface-hover hover:text-fg-secondary focus-visible:bg-surface-hover"
        >
          {hidden} more
        </Button>
      ) : null}
      {more > 0 && hidden === 0 ? (
        <p className="border-t border-line-subtle px-3 py-1.5 text-meta text-fg-tertiary">
          {plural(more, "more file")} not listed
        </p>
      ) : null}
    </section>
  );
}
