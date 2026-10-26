import { X } from "lucide-react";

import { Reveal } from "../../components/Reveal.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { useLingering } from "../../lib/motion.ts";
import { lineRange } from "./draft.ts";
import { nameOf } from "../files/model.ts";
import type { DraftComment } from "./draft.ts";

/**
 * The comments the draft makes, on passages of the agent's responses and on lines of its diffs,
 * above its text: each passage or marked run on one line, the remark below it to edit in place. A
 * comment grows into the list as it's added and folds out as it's removed.
 */
export function CommentTray({
  comments,
  onEdit,
  onRemove,
}: {
  comments: ReadonlyArray<DraftComment>;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [rows, release] = useLingering(comments, (comment) => comment.id);
  return (
    <ScrollArea viewportClassName="max-h-48">
      {/* The space between comments is inside each, so it folds away with the comment. */}
      <ul className="flex flex-col px-3 pt-1.5">
        {rows.map(({ key, item: comment, present }) => (
          <li key={key}>
            <Reveal onGone={() => release(key)}>
              {present ? (
                <div className="pt-1.5">
                  <div className="group/comment relative rounded-lg border border-line-subtle bg-surface-hover py-1.5 pr-8 pl-2.5">
                    {/* The run a comment sits on, named by its file and lines; a passage as the reply shows it. */}
                    <p
                      title={
                        comment.file === undefined
                          ? comment.quote
                          : `${comment.file.path}:${lineRange(comment.file.start, comment.file.end)}\n${comment.quote}`
                      }
                      className={`truncate border-l-2 border-accent/60 pl-2 text-meta text-fg-tertiary ${
                        comment.file === undefined ? "" : "flex items-baseline gap-1.5 font-mono tabular-nums"
                      }`}
                    >
                      {comment.file === undefined ? (
                        comment.quote
                      ) : (
                        <>
                          <span className="min-w-0 truncate">{nameOf(comment.file.path)}</span>
                          <span className="shrink-0">{lineRange(comment.file.start, comment.file.end)}</span>
                        </>
                      )}
                    </p>
                    <textarea
                      aria-label="Comment"
                      value={comment.text}
                      rows={1}
                      placeholder="Add a comment"
                      onChange={(event) => onEdit(comment.id, event.target.value)}
                      className="mt-1 block max-h-24 w-full resize-none bg-transparent text-body text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-disabled"
                    />
                    {/* Shown at rest on a touch screen, which has no hover to bring it out. */}
                    <button
                      type="button"
                      aria-label="Remove comment"
                      onClick={() => onRemove(comment.id)}
                      className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-md text-fg-tertiary opacity-0 transition-opacity group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 pointer-coarse:opacity-100"
                    >
                      <X size={12} strokeWidth={2.25} />
                    </button>
                  </div>
                </div>
              ) : null}
            </Reveal>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
