import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { X } from "lucide-react";

import { commitDiffAtom, commitDiffKey } from "../../../backend/history.ts";
import { FileIcon } from "../../../components/FileIcon.tsx";
import { IconButton } from "../../../components/ui/IconButton.tsx";
import { ContextMenuArea } from "../../../components/ui/Menu.tsx";
import { dirOf, nameOf } from "../../files/model.ts";
import type { PaneChrome } from "../../split/SplitView.tsx";
import { DiffView } from "../../viewer/DiffView.tsx";
import { diffLayoutAtom } from "../../viewer/model.ts";
import { Note, messageOf } from "../../viewer/previews.tsx";

// A file as one commit changed it, against the commit's first parent: the same diff the viewer shows of
// a changed file, laid out the same way the user chose. Its header names the file and the commit.

/** Unchanged lines around each change, as the viewer shows them. */
const CONTEXT = 3;

export function CommitFileView({
  root,
  sha,
  path,
  from,
  onClose,
  pane,
}: {
  /** The work thread's folder the commit is read in. */
  readonly root: string;
  readonly sha: string;
  /** The file, relative to `root`. */
  readonly path: string;
  /** Where it was before a rename. */
  readonly from?: string | undefined;
  readonly onClose: () => void;
  /** While it shares the main area with other panes, its header is the pane's: dragged by, with the pane's menu. */
  readonly pane?: PaneChrome | undefined;
}) {
  const result = useAtomValue(commitDiffAtom(commitDiffKey(root, sha, path, from, CONTEXT)));
  const diff = Option.getOrUndefined(AsyncResult.value(result));
  const [layout] = useAtom(diffLayoutAtom);
  const dir = dirOf(path);

  const header = (
    <header
      {...pane?.grip}
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12 ${pane ? "select-none" : ""}`}
    >
      <FileIcon path={path} className="size-4 shrink-0" />
      <span className="flex min-w-0 items-baseline gap-2 text-body max-md:text-[15px]">
        <span className="shrink-0 font-medium text-fg-primary">{nameOf(path)}</span>
        {dir === "" ? null : (
          <span className="min-w-0 truncate text-meta text-fg-tertiary" title={path}>
            {dir}
          </span>
        )}
      </span>
      <span className="ml-auto shrink-0 font-mono text-meta text-fg-tertiary" title={`Commit ${sha}`}>
        {sha.slice(0, 7)}
      </span>
      <IconButton icon={X} label="Close" shortcut="Ctrl W" onClick={onClose} className="max-md:size-10" />
    </header>
  );

  const body = (() => {
    if (diff === undefined) {
      return AsyncResult.isFailure(result) ? (
        <Note>{messageOf(result.cause, "That file's change couldn't be read.")}</Note>
      ) : null;
    }
    if (diff.binary === true) return <Note>This commit changed a file that isn't text.</Note>;
    if (diff.hunks.length === 0) {
      return (
        <Note>
          {from !== undefined
            ? `Renamed from ${from}, contents unchanged.`
            : "This commit didn't change its contents."}
        </Note>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <DiffView hunks={diff.hunks} path={path} layout={layout} onExpand={undefined} />
        </div>
        {diff.truncated === true ? (
          <p className="shrink-0 border-t border-line-subtle px-4 py-1.5 text-meta text-fg-tertiary">
            A long diff, cut short.
          </p>
        ) : null}
      </div>
    );
  })();

  return (
    <section aria-label={nameOf(path)} className="flex h-full flex-col">
      {pane ? <ContextMenuArea menu={pane.menu}>{header}</ContextMenuArea> : header}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
