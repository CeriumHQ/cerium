import type { FileChange } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";

import { commitDetailAtom } from "../../../backend/history.ts";
import { StateLetter } from "../../files/FileStatus.tsx";
import { CopyButton } from "../../transcript/CopyButton.tsx";
import { Note, messageOf } from "../../viewer/previews.tsx";
import { refLabel, refTone, splitPath } from "./model.ts";

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
          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-[15px] leading-snug font-semibold text-fg-primary">
                {detail.commit.subject}
              </h2>
              <p className="text-[12px] text-fg-tertiary">
                {detail.commit.author} · {new Date(detail.commit.at).toLocaleString()}
              </p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-fg-secondary">{detail.commit.sha}</span>
                <CopyButton text={detail.commit.sha} label="Copy commit SHA" />
              </div>
              {detail.commit.refs.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {detail.commit.refs.map((ref) => (
                    <span
                      key={`${ref.kind}:${ref.name}`}
                      className={`rounded border px-1.5 text-[11px] leading-4 ${refTone(ref)}`}
                    >
                      {refLabel(ref)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {detail.message !== detail.commit.subject ? (
              <pre className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg-secondary">
                {detail.message}
              </pre>
            ) : null}
            <section className="flex flex-col gap-1">
              <h3 className="text-[11px] font-semibold tracking-wide text-fg-tertiary uppercase">
                {detail.files.length === 0 ? "No files here" : `${detail.files.length} files changed`}
                {detail.truncated === true ? " (first ones shown)" : ""}
              </h3>
              {detail.files.map((file) => {
                const { folder, name } = splitPath(file.path);
                return (
                  <button
                    key={`${file.from ?? ""}>${file.path}`}
                    type="button"
                    onClick={() => onOpenFile(file)}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors hover:bg-surface-hover"
                  >
                    <StateLetter state={file.state} />
                    <span className="min-w-0 truncate">
                      <span className="text-fg-tertiary">{folder}</span>
                      <span className="text-fg-primary">{name}</span>
                    </span>
                    {file.from === undefined ? null : (
                      <span className="ml-auto truncate text-[11px] text-fg-tertiary">from {file.from}</span>
                    )}
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
