import { Fragment } from "react";

import { editLines, type FileEdit } from "./diff.ts";

const marker = { context: " ", removed: "−", added: "+" } as const;

const tint = {
  context: "text-fg-tertiary",
  removed: "bg-error/10 text-fg-primary",
  added: "bg-success/10 text-fg-primary",
} as const;

const markerTint = { context: "", removed: "text-error", added: "text-success" } as const;

/** A file edit as a compact diff, several edits to one file separated by a gap marker. */
export function EditDiff({ edits }: { edits: ReadonlyArray<FileEdit> }) {
  return (
    <div className="scroll-thin max-h-60 overflow-auto rounded-md border border-line-subtle bg-surface-window py-1.5 font-mono text-meta leading-[1.6] select-text">
      <div className="grid w-max min-w-full">
        {edits.map((edit, index) => (
          <Fragment key={index}>
            {index > 0 ? <div className="px-2.5 text-fg-disabled select-none">⋯</div> : null}
            {editLines(edit.before, edit.after).map((line, lineIndex) => (
              <div key={lineIndex} className={`flex px-2.5 whitespace-pre ${tint[line.kind]}`}>
                <span className={`w-4 shrink-0 select-none ${markerTint[line.kind]}`} aria-hidden="true">
                  {marker[line.kind]}
                </span>
                {line.kind === "context" ? null : (
                  <span className="sr-only">{line.kind === "removed" ? "Removed: " : "Added: "}</span>
                )}
                <span>{line.text === "" ? " " : line.text}</span>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
