import type { FileChange } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";

import { commitDetailAtom } from "../../../backend/history.ts";
import { FileIcon } from "../../../components/FileIcon.tsx";
import { StateLetter } from "../../files/FileStatus.tsx";
import { CopyButton } from "../../transcript/CopyButton.tsx";
import { Note, messageOf } from "../../viewer/previews.tsx";
import { splitPath } from "./model.ts";
import { RefChip } from "./RefChip.tsx";

// One commit in full: its message, and the files under the folder it changed. Each file opens its diff
// against the commit's first parent in the viewer.

interface CommitViewProps {
  /** The work thread's folder the commit is read in. */
  readonly root: string;
  readonly sha: string;
  /** Back to the list. */
  readonly onBack: () => void;
  /** Opens a file this commit changed, against its first parent. */
  readonly onOpenFile: (file: FileChange) => void;
}

export function CommitView({ root, sha, onBack, onOpenFile }: CommitViewProps) {
  const result = useAtomValue(commitDetailAtom(`${root}\n${sha}`));
  const detail = AsyncResult.isSuccess(result) ? result.value : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          <ArrowLeft size={13} strokeWidth={1.75} />
          History
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {AsyncResult.isFailure(result) ? (
          <Note>{messageOf(result.cause, "That commit couldn't be read.")}</Note>
        ) : detail === undefined ? (
          <p className="px-4 py-3 text-[12px] text-fg-tertiary">Loading commit…</p>
        ) : (
          <div className="flex flex-col gap-4 py-3">
            <div className="flex flex-col gap-1.5 px-3">
              <h2 className="text-[14px] leading-snug font-semibold text-pretty text-fg-primary max-md:text-[16px]">
                {detail.commit.subject}
              </h2>
              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-fg-tertiary max-md:text-[13px]">
                <span className="truncate">{detail.commit.author}</span>
                <span aria-hidden>·</span>
                <time dateTime={new Date(detail.commit.at).toISOString()}>
                  {new Date(detail.commit.at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </p>
              <div className="-ml-0.5 flex min-w-0 flex-wrap items-center gap-1">
                <span className="flex shrink-0 items-center">
                  <span title={detail.commit.sha} className="pl-0.5 font-mono text-[12px] text-fg-secondary">
                    {detail.commit.short}
                  </span>
                  <CopyButton text={detail.commit.sha} label="Copy the full SHA" />
                </span>
                {detail.commit.refs.map((ref) => (
                  <RefChip key={`${ref.kind}:${ref.name}`} marker={ref} />
                ))}
              </div>
            </div>
            {detail.message !== detail.commit.subject ? (
              <pre className="px-3 font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-secondary max-md:text-[14px]">
                {detail.message.startsWith(detail.commit.subject)
                  ? detail.message.slice(detail.commit.subject.length).replace(/^\s+/, "")
                  : detail.message}
              </pre>
            ) : null}
            <section aria-label="Files changed" className="flex flex-col px-1.5">
              <h3 className="flex h-7 items-center px-1.5 text-2xs font-medium text-fg-tertiary max-md:h-9 max-md:text-[12.5px]">
                {detail.files.length === 0
                  ? "No files changed here"
                  : detail.files.length === 1
                    ? "1 file changed"
                    : `${detail.files.length} files changed`}
                {detail.truncated === true ? ", the first ones shown" : ""}
              </h3>
              {detail.files.map((file) => {
                const { folder, name } = splitPath(file.path);
                return (
                  <button
                    key={`${file.from ?? ""}>${file.path}`}
                    type="button"
                    onClick={() => onOpenFile(file)}
                    title={file.from === undefined ? file.path : `${file.path}, from ${file.from}`}
                    className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] outline-none transition-colors select-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:h-11 max-md:text-[14px]"
                  >
                    <FileIcon path={file.path} className="size-4" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span
                        className={`shrink-0 ${file.state === "deleted" ? "text-fg-tertiary line-through" : "text-fg-primary"}`}
                      >
                        {name}
                      </span>
                      <span className="min-w-0 truncate text-fg-tertiary">{folder.replace(/\/$/, "")}</span>
                    </span>
                    <span className="grid w-4 shrink-0 place-items-center">
                      <StateLetter state={file.state} />
                    </span>
                  </button>
                );
              })}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
