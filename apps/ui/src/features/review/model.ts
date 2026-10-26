import type { ProviderId, RosterMember } from "@cerium/protocol";
import type { ReviewerModel, ReviewFinding, ReviewRecord, ReviewTarget } from "@cerium/rpc";

import type { DraftCommentFile } from "../composer/draft.ts";
import { lineRange } from "../composer/draft.ts";
import { providerName } from "../threads/model.ts";

// Reviews of a diff by an agent on another harness, as the window offers and shows them: which models
// may review, which review a place shows, which findings sit on a diff's lines, and what a finding
// sent to the thread's agent says.

/** A model the user may review with, from the roster. */
export interface ReviewerOption {
  readonly reviewer: ReviewerModel;
  readonly label: string;
  /** It runs on another harness than the thread's lead: the review the feature is for. */
  readonly other: boolean;
}

export const reviewerKey = (reviewer: Pick<ReviewerModel, "provider" | "model">) =>
  `${reviewer.provider}/${reviewer.model}`;

/**
 * The roster's models of the harnesses that can run, those on another harness than the lead's first,
 * each harness's in the order the roster prefers them.
 */
export const reviewerOptions = (
  members: ReadonlyArray<RosterMember>,
  ready: ReadonlySet<ProviderId>,
  lead: ProviderId | undefined,
): ReadonlyArray<ReviewerOption> => {
  const options = members
    .filter((member) => ready.has(member.model.provider))
    .map((member): ReviewerOption => ({
      reviewer: { provider: member.model.provider, model: member.model.id },
      label: member.model.label,
      other: member.model.provider !== lead,
    }));
  return [...options.filter((option) => option.other), ...options.filter((option) => !option.other)];
};

/**
 * The model a review runs on: the user's pick while it's still on offer, else the first on another
 * harness than the lead's, else the first at all.
 */
export const chosenReviewer = (
  options: ReadonlyArray<ReviewerOption>,
  picked: string | undefined,
): ReviewerOption | undefined =>
  options.find((option) => reviewerKey(option.reviewer) === picked) ?? options[0];

/** Two targets that read the same diff. */
export const sameTarget = (a: ReviewTarget, b: ReviewTarget): boolean => {
  if (a._tag === "Changes" && b._tag === "Changes") return a.root === b.root;
  if (a._tag === "Branch" && b._tag === "Branch") return a.cwd === b.cwd && a.base === b.base;
  if (a._tag === "Turn" && b._tag === "Turn") return a.turnId === b.turnId && a.after === b.after;
  return false;
};

/** The latest review of `target`, the one a place shows. */
export const latestReview = (
  reviews: ReadonlyArray<ReviewRecord>,
  target: ReviewTarget,
): ReviewRecord | undefined => reviews.findLast((review) => sameTarget(review.target, target));

/** Which reviews a diff's lines carry the findings of: those of what the next commit takes, or one turn's. */
export type DiffScope =
  | { readonly _tag: "Changes"; readonly root: string }
  | { readonly _tag: "Turn"; readonly after: string };

const inScope = (target: ReviewTarget, scope: DiffScope) =>
  scope._tag === "Changes"
    ? target._tag === "Changes" && samePath(target.root, scope.root)
    : target._tag === "Turn" && target.after === scope.after;

/** Folders compared as Windows and git may each write them. */
const samePath = (a: string, b: string) =>
  a.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase() ===
  b.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();

/** A finding with the review it came from. */
export interface PlacedFinding {
  readonly review: ReviewRecord;
  readonly finding: ReviewFinding;
}

/**
 * The open findings on `path` of the latest finished review in `scope`, which a diff of it shows under
 * their lines. `root` is the folder `path` is relative to; a review's paths are from its repository's
 * top, which a diff in a subfolder still ends with.
 */
export const findingsOn = (
  reviews: ReadonlyArray<ReviewRecord>,
  scope: DiffScope,
  path: string,
): ReadonlyArray<PlacedFinding> => {
  const review = reviews.findLast((each) => each.state === "done" && inScope(each.target, scope));
  if (review === undefined) return [];
  const plain = path.replaceAll("\\", "/");
  return review.findings
    .filter(
      (finding) =>
        finding.state === "open" &&
        finding.lines.length > 0 &&
        (finding.path === plain || finding.path.endsWith(`/${plain}`) || plain.endsWith(`/${finding.path}`)),
    )
    .map((finding) => ({ review, finding }));
};

/** The findings that hang under a diff's line: those whose last line it is. */
export const findingsUnder = (
  placed: ReadonlyArray<PlacedFinding>,
  line: { readonly kind: "context" | "removed" | "added"; readonly old?: number; readonly new?: number },
): ReadonlyArray<PlacedFinding> =>
  placed.filter(({ finding }) => {
    const last = finding.lines.at(-1)!;
    return last.marker === "-"
      ? line.kind === "removed" && line.old === last.number
      : line.kind !== "removed" && line.new === last.number;
  });

/** The numbers of the lines `placed` cover, for marking their edge as waiting comments are marked. */
export const coveredLines = (placed: ReadonlyArray<PlacedFinding>): ReadonlySet<number> =>
  new Set(placed.flatMap(({ finding }) => finding.lines.map((line) => line.number)));

/** The reviewer as the window names it: "GPT-6 Luna", with its harness when asked. */
export const reviewerName = (
  reviewer: ReviewerModel,
  labelOf: (provider: ProviderId, model: string) => string,
  withHarness = false,
): string => {
  const label = labelOf(reviewer.provider, reviewer.model);
  return withHarness ? `${label} on ${providerName[reviewer.provider]}` : label;
};

/** Where a finding sits, as the tray and the card name it: `src/a.ts:12-14`. */
export const findingPlace = (finding: ReviewFinding): string =>
  finding.start > 0 ? `${finding.path}:${lineRange(finding.start, finding.end)}` : finding.path;

/**
 * A finding as a comment for the message box's tray: on the diff's lines when it covers some, else
 * on the place it names, with the reviewer's words as the remark.
 */
export const findingComment = (
  finding: ReviewFinding,
  reviewer: string,
): { readonly quote: string; readonly text: string; readonly file?: DraftCommentFile } => {
  const text = [`${reviewer} reviewed this: ${finding.title}`, finding.body]
    .filter((part) => part !== "")
    .join("\n\n");
  if (finding.lines.length === 0) return { quote: findingPlace(finding), text };
  const numbers = finding.lines.map((line) => line.number);
  return {
    quote: finding.lines.map((line) => `${line.marker} ${line.text}`).join("\n"),
    text,
    file: {
      path: finding.path,
      start: Math.min(...numbers),
      end: Math.max(...numbers),
      lines: finding.lines,
    },
  };
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What a finished review found, in a few words: "3 findings, 1 high", "No findings". */
export const findingsHeadline = (review: ReviewRecord): string => {
  if (review.findings.length === 0) return "No findings";
  const high = review.findings.filter((finding) => finding.severity === "high").length;
  return `${plural(review.findings.length, "finding")}${high > 0 ? `, ${high} high` : ""}`;
};
