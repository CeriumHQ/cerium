import { X } from "lucide-react";

import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import type { DraftComment } from "./draft.ts";

/**
 * The comments the draft makes on passages of the agent's responses, above its text: each passage
 * on one line, the remark below it to edit in place.
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
  return (
    <ScrollArea viewportClassName="max-h-48">
      <ul className="flex flex-col gap-1.5 px-3 pt-3">
        {comments.map((comment) => (
          <li
            key={comment.id}
            className="group/comment relative rounded-lg border border-line-subtle bg-surface-hover py-1.5 pr-8 pl-2.5"
          >
            <p
              title={comment.quote}
              className="truncate border-l-2 border-accent/60 pl-2 text-[12px] text-fg-tertiary"
            >
              {comment.quote}
            </p>
            <textarea
              aria-label="Comment"
              value={comment.text}
              rows={1}
              placeholder="Add a comment"
              onChange={(event) => onEdit(comment.id, event.target.value)}
              className="mt-1 block max-h-24 w-full resize-none bg-transparent text-[13px] text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-disabled"
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
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
