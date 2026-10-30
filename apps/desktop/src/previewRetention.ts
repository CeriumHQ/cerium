/** Hidden, unowned pages keep their navigation history, with at most four renderers kept warm. */
export const PREVIEW_IDLE_MS = 5 * 60_000;
export const WARM_PREVIEWS = 4;

export interface PreviewUsage {
  readonly threadId: string;
  readonly shown: boolean;
  readonly active: boolean;
  readonly calls: number;
  readonly lastUsed: number;
  readonly parkedUntil: number;
  readonly retired: boolean;
}

/** A running agent and an in-flight browser call both own their page, even in the background. */
export const releasablePreviews = (
  pages: ReadonlyArray<PreviewUsage>,
  now: number,
): ReadonlyArray<string> => {
  const unused = pages
    .filter(
      (page) =>
        !page.active && page.calls === 0 && (page.retired || (!page.shown && page.parkedUntil <= now)),
    )
    .toSorted((a, b) => b.lastUsed - a.lastUsed);
  let warm = 0;
  return unused.flatMap((page) => {
    if (page.retired || now - page.lastUsed >= PREVIEW_IDLE_MS) return [page.threadId];
    return ++warm > WARM_PREVIEWS ? [page.threadId] : [];
  });
};
