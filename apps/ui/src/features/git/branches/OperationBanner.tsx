import type { GitOperationKind, UnmergedFile } from "@cerium/rpc";
import { GitMerge } from "lucide-react";

import { Tooltip } from "../../../components/ui/Tooltip.tsx";
import type { BranchDialog } from "./BranchDialogs.tsx";
import { canSkip, conflictNote, operationNote, operationTitle, sideHelp } from "./model.ts";
import type { BranchControls } from "./useBranchControls.ts";

const buttonClass =
  "h-7 rounded-md px-2 text-meta font-medium text-fg-secondary transition-colors select-none hover:bg-surface-hover hover:text-fg-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-secondary max-md:h-9 max-md:px-3 max-md:text-[14px]";

/**
 * What git stopped halfway through (a merge, rebase, cherry-pick or revert) and what it waits for:
 * each file the two sides disagree on, with the way to settle it, and the way on or out.
 */
export function OperationBanner({
  controls,
  onAsk,
  onOpen,
}: {
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
  /** Opens a conflicted file in the viewer, by its path from the repository's top. */
  readonly onOpen: ((path: string) => void) | undefined;
}) {
  const state = controls.state;
  if (state === undefined || (state.operation === undefined && state.conflicts.length === 0)) return null;
  const kind = state.operation?.kind;
  const busy = controls.busy !== undefined;
  const waiting = state.conflicts.length > 0;
  return (
    <section
      aria-label="Operation in progress"
      className="flex flex-col gap-2 border-b border-line-subtle bg-surface-sunken px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <GitMerge size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-attention-text" />
        <div className="flex min-w-0 flex-col">
          <h3 className="text-body font-medium text-fg-primary max-md:text-[15px]">
            {operationTitle(state)}
          </h3>
          <p className="text-meta text-fg-tertiary max-md:text-[14px]">{operationNote(state)}</p>
        </div>
      </div>
      {state.operation === undefined ? null : (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={busy || waiting}
            onClick={() => void controls.operation("continue")}
            className="h-7 rounded-md bg-accent px-2.5 text-meta font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-40 max-md:h-9 max-md:px-3 max-md:text-[14px]"
          >
            Continue
          </button>
          {kind !== undefined && canSkip(kind) ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void controls.operation("skip")}
              className={buttonClass}
            >
              Skip
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onAsk({ kind: "abort" })}
            className={`${buttonClass} hover:text-error-text`}
          >
            Abort
          </button>
        </div>
      )}
      {waiting ? (
        <ul className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-lg border border-line-subtle">
          {state.conflicts.map((file) => (
            <Conflict key={file.path} file={file} kind={kind} controls={controls} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Conflict({
  file,
  kind,
  controls,
  onOpen,
}: {
  readonly file: UnmergedFile;
  readonly kind: GitOperationKind | undefined;
  readonly controls: BranchControls;
  readonly onOpen: ((path: string) => void) | undefined;
}) {
  const busy = controls.busy !== undefined;
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash === -1 ? "" : file.path.slice(0, slash);
  const choose = (side: "ours" | "theirs" | "resolved") => void controls.resolve(file.path, side);
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <Tooltip label={file.path} side="top">
          <span className="min-w-0 truncate text-body text-fg-primary max-md:text-[15px]">
            {name}
            {folder === "" ? null : <span className="ml-1.5 text-meta text-fg-tertiary">{folder}</span>}
          </span>
        </Tooltip>
      </div>
      <p className="text-meta text-fg-tertiary max-md:text-[13px]">{conflictNote(file)}</p>
      <div className="-ml-2 flex flex-wrap items-center gap-0.5">
        {onOpen === undefined ? null : (
          <button type="button" onClick={() => onOpen(file.path)} className={buttonClass}>
            Open
          </button>
        )}
        <Tooltip label={sideHelp(kind, "ours")} side="bottom">
          <button type="button" disabled={busy} onClick={() => choose("ours")} className={buttonClass}>
            Take ours
          </button>
        </Tooltip>
        <Tooltip label={sideHelp(kind, "theirs")} side="bottom">
          <button type="button" disabled={busy} onClick={() => choose("theirs")} className={buttonClass}>
            Take theirs
          </button>
        </Tooltip>
        <Tooltip label="Keep the file as it is now, once you've edited it." side="bottom">
          <button type="button" disabled={busy} onClick={() => choose("resolved")} className={buttonClass}>
            Mark resolved
          </button>
        </Tooltip>
      </div>
    </li>
  );
}
