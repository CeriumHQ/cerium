import type { ThreadId } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { createElement } from "react";

import type { DraftComment } from "../composer/draft.ts";
import { draftCommentsAtom, isNewDraftKey } from "../composer/drafts.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import { useReviewsOffered, useThreadReviews } from "../review/hooks.ts";
import { coveredLines, findingsOn, findingsUnder, type DiffScope } from "../review/model.ts";
import { FindingComment } from "../review/ReviewCard.tsx";
import type { DiffCommenting } from "./DiffView.tsx";

// The lines a diff lets the user comment on, and the ones a comment already waits on: both come from
// the draft the window's message box writes to, where they wait until the next message sends them.
// A review's open findings on the file hang under their lines beside them, as comments to send or
// dismiss.

/** The comments of `comments` that sit on lines of `path`. */
export const commentsOn = (
  comments: ReadonlyArray<DraftComment>,
  path: string,
): ReadonlyArray<DraftComment> =>
  comments.filter((comment) => comment.file !== undefined && comment.file.path === path);

/**
 * What a diff of `path` offers: a comment run added into the routed thread's draft, the numbers its
 * waiting comments and the open findings of the thread's latest review in `scope` cover, for marking
 * their lines, and those findings under their lines. None while there is no open thread to write to,
 * or the view holds no box to write with.
 */
export const useDiffComments = ({
  messageBox,
  draftKey,
  path,
  scope,
}: {
  messageBox: MessageBox | undefined;
  /** The draft the window's message box writes to; none while no thread shows to write in. */
  draftKey: string | undefined;
  path: string;
  /** Which reviews' findings the diff shows; none where it shows none. */
  scope?: DiffScope | undefined;
}): DiffCommenting | undefined => {
  const comments = useAtomValue(draftCommentsAtom(draftKey ?? ""));
  const offered = useReviewsOffered();
  // A thread not started yet has no reviews; its key reads as an empty list.
  const threadId = (draftKey === undefined || isNewDraftKey(draftKey) ? "" : draftKey) as ThreadId;
  const reviews = useThreadReviews(threadId);
  if (messageBox === undefined || draftKey === undefined) return undefined;
  const placed = scope === undefined || !offered || threadId === "" ? [] : findingsOn(reviews, scope, path);
  const marked = new Set<number>(coveredLines(placed));
  for (const comment of commentsOn(comments, path)) {
    const file = comment.file!;
    for (let at = file.start; at <= file.end; at++) marked.add(at);
  }
  return {
    marked,
    onAdd: ({ quote, text, file }) => messageBox.comment({ quote, text, file }),
    ...(placed.length === 0
      ? {}
      : {
          under: (line) =>
            findingsUnder(placed, line).map((each) =>
              createElement(FindingComment, { key: each.finding.id, placed: each, threadId }),
            ),
        }),
  };
};
