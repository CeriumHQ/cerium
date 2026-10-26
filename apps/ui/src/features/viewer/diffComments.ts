import { useAtomValue } from "@effect/atom-react";

import type { DraftComment } from "../composer/draft.ts";
import { draftCommentsAtom } from "../composer/drafts.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import type { DiffCommenting } from "./DiffView.tsx";

// The lines a diff lets the user comment on, and the ones a comment already waits on: both come from
// the draft the window's message box writes to, where they wait until the next message sends them.

/** The comments of `comments` that sit on lines of `path`. */
export const commentsOn = (
  comments: ReadonlyArray<DraftComment>,
  path: string,
): ReadonlyArray<DraftComment> =>
  comments.filter((comment) => comment.file !== undefined && comment.file.path === path);

/**
 * What a diff of `path` offers: a comment run added into the routed thread's draft, and the numbers
 * its waiting comments cover, for marking their lines. None while there is no open thread to write
 * to, or the view holds no box to write with.
 */
export const useDiffComments = ({
  messageBox,
  draftKey,
  path,
}: {
  messageBox: MessageBox | undefined;
  /** The draft the window's message box writes to; none while no thread shows to write in. */
  draftKey: string | undefined;
  path: string;
}): DiffCommenting | undefined => {
  const comments = useAtomValue(draftCommentsAtom(draftKey ?? ""));
  if (messageBox === undefined || draftKey === undefined) return undefined;
  const marked = new Set<number>();
  for (const comment of commentsOn(comments, path)) {
    const file = comment.file!;
    for (let at = file.start; at <= file.end; at++) marked.add(at);
  }
  return {
    marked,
    onAdd: ({ quote, text, file }) => messageBox.comment({ quote, text, file }),
  };
};
