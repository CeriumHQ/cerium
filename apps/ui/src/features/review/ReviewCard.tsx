import { Button } from "@base-ui/react/button";
import type { ThreadId } from "@cerium/protocol";
import type { ReviewFinding, ReviewRecord, ReviewTarget } from "@cerium/rpc";
import { useAtomSet } from "@effect/atom-react";
import { ChevronRight, Glasses, LoaderCircle, Send, Undo2, X } from "lucide-react";
import { useState } from "react";

import { resolveReviewFinding, stopReview } from "../../backend/reviews.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useMessageBox } from "../composer/messageBox.ts";
import { useModelLabel, useThreadReviews } from "./hooks.ts";
import {
  findingComment,
  findingPlace,
  findingsHeadline,
  latestReview,
  reviewerName,
  type PlacedFinding,
} from "./model.ts";

// A review as the places that start one show it, and its findings: each sent to the thread's agent
// as a comment in the message box's tray, or dismissed. The same finding shows under its lines in
// the diff (`FindingComment`), with the same two actions.

const severityMark: Record<ReviewFinding["severity"], string> = {
  high: "bg-error",
  medium: "bg-attention",
  low: "bg-fg-disabled",
};
const severityName: Record<ReviewFinding["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const action =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-fg-secondary outline-none transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-1 focus-visible:ring-focus-ring disabled:opacity-40 max-md:h-9 max-md:px-2.5 max-md:text-[14px]";

/**
 * What the user does with a review's findings: send one to the thread's agent, in the message box's
 * tray as a comment on its lines, or dismiss it, or bring a dismissed one back. Sending needs the
 * thread's own message box.
 */
export const useFindingActions = (threadId: ThreadId) => {
  const messageBox = useMessageBox();
  const resolve = useAtomSet(resolveReviewFinding, { mode: "promise" });
  const labelOf = useModelLabel();
  const mark = (review: ReviewRecord, finding: ReviewFinding, state: ReviewFinding["state"]) =>
    void resolve({ payload: { reviewId: review.id, findingId: finding.id, state } }).catch(() => undefined);
  const canSend = messageBox !== undefined && messageBox.key() === threadId;
  return {
    canSend,
    send: ({ review, finding }: PlacedFinding) => {
      if (!canSend) return;
      messageBox.comment(findingComment(finding, reviewerName(review.reviewer, labelOf)));
      mark(review, finding, "sent");
    },
    dismiss: ({ review, finding }: PlacedFinding) => mark(review, finding, "dismissed"),
    reopen: ({ review, finding }: PlacedFinding) => mark(review, finding, "open"),
  };
};

type FindingActions = ReturnType<typeof useFindingActions>;

/** A finding's severity; `centred` on a one-line row, else level with the first line of a longer one. */
function SeverityDot({
  severity,
  centred = false,
}: {
  severity: ReviewFinding["severity"];
  centred?: boolean;
}) {
  return (
    <span
      title={`${severityName[severity]} severity`}
      className={`${centred ? "" : "mt-[7px]"} size-1.5 shrink-0 rounded-full ${severityMark[severity]}`}
    >
      <span className="sr-only">{severityName[severity]} severity</span>
    </span>
  );
}

/** A reviewer's words, its `code` spans drawn as the transcript draws inline code. */
function Prose({ text }: { text: string }) {
  return text.split(/`([^`\n]+)`/).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} data-md="inline-code" className="font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

function FindingButtons({ placed, actions }: { placed: PlacedFinding; actions: FindingActions }) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip
        label={
          actions.canSend
            ? "Adds it to your message to the thread's agent, as a comment on these lines"
            : "Open the thread to send it to its agent"
        }
      >
        <Button
          onClick={() => actions.send(placed)}
          disabled={!actions.canSend}
          focusableWhenDisabled
          className={action}
        >
          <Send size={12} strokeWidth={1.75} />
          Send to agent
        </Button>
      </Tooltip>
      <Button onClick={() => actions.dismiss(placed)} className={action}>
        <X size={12} strokeWidth={1.75} />
        Dismiss
      </Button>
    </div>
  );
}

/** A finding's lines as the diff showed them, for the card that lists it away from the diff. */
function Snippet({ finding }: { finding: ReviewFinding }) {
  const shown = finding.lines.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <pre className="scroll-thin overflow-x-auto rounded-md bg-surface-sunken py-1 font-mono text-[11.5px] leading-[1.55]">
      {shown.map((line, index) => (
        <div
          key={index}
          className={`px-2 whitespace-pre ${
            line.marker === "+" ? "bg-success/10" : line.marker === "-" ? "bg-error/10" : ""
          }`}
        >
          <span
            className={
              line.marker === "+"
                ? "text-success-text"
                : line.marker === "-"
                  ? "text-error-text"
                  : "text-fg-disabled"
            }
          >
            {line.marker === "-" ? "−" : line.marker}
          </span>{" "}
          {line.text}
        </div>
      ))}
      {finding.lines.length > shown.length ? (
        <div className="px-2 text-fg-tertiary">…{finding.lines.length - shown.length} more</div>
      ) : null}
    </pre>
  );
}

/** One finding in a review's list: what's wrong, where, why, and its two actions. */
function FindingRow({ placed, actions }: { placed: PlacedFinding; actions: FindingActions }) {
  const { finding } = placed;
  return (
    <li className="flex gap-2.5 border-t border-line-subtle px-3 py-2.5 first:border-t-0">
      <SeverityDot severity={finding.severity} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-col">
          <p className="text-body text-fg-primary">
            <Prose text={finding.title} />
          </p>
          <p className="truncate font-mono text-[11.5px] text-fg-tertiary" title={findingPlace(finding)}>
            {findingPlace(finding)}
          </p>
        </div>
        {finding.body === "" ? null : (
          <p className="text-meta leading-relaxed whitespace-pre-wrap text-fg-secondary">
            <Prose text={finding.body} />
          </p>
        )}
        <Snippet finding={finding} />
        <div className="-ml-1.5">
          <FindingButtons placed={placed} actions={actions} />
        </div>
      </div>
    </li>
  );
}

/**
 * A finding under its last line in a diff, as a comment waiting there: the reviewer, what's wrong and
 * why, and the two actions.
 */
export function FindingComment({ placed, threadId }: { placed: PlacedFinding; threadId: ThreadId }) {
  const actions = useFindingActions(threadId);
  const labelOf = useModelLabel();
  const { review, finding } = placed;
  return (
    // As wide as the visible view and pinned left, so scrolling sideways never carries it away.
    <div className="sticky left-0 font-sans" style={{ width: "100cqw" }}>
      <div className="mx-2 my-1.5 flex gap-2.5 rounded-lg border border-line-subtle bg-surface-raised px-3 py-2 shadow-sm">
        <SeverityDot severity={finding.severity} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5 text-caption text-fg-tertiary">
            <ProviderLogo provider={review.reviewer.provider} size={11} className="shrink-0" />
            <span className="truncate">{reviewerName(review.reviewer, labelOf, true)}</span>
          </div>
          <p className="text-body text-fg-primary">
            <Prose text={finding.title} />
          </p>
          {finding.body === "" ? null : (
            <p className="text-meta leading-relaxed whitespace-pre-wrap text-fg-secondary">
              <Prose text={finding.body} />
            </p>
          )}
          <div className="-ml-1.5">
            <FindingButtons placed={placed} actions={actions} />
          </div>
        </div>
      </div>
    </div>
  );
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The latest review of `target` in the thread, while there is one: its reviewer at work, or what it
 * found, open findings listed with their actions and those already sent or dismissed folded to a
 * line. `framed` draws its own border; otherwise it sits inside a card of the place's.
 */
export function ReviewCard({
  threadId,
  target,
  framed = true,
}: {
  threadId: ThreadId;
  target: ReviewTarget;
  framed?: boolean;
}) {
  const reviews = useThreadReviews(threadId);
  const review = latestReview(reviews, target);
  const actions = useFindingActions(threadId);
  const labelOf = useModelLabel();
  const stop = useAtomSet(stopReview, { mode: "promise" });
  const [showResolved, setShowResolved] = useState(false);
  if (review === undefined) return null;

  const who = reviewerName(review.reviewer, labelOf, true);
  const open = review.findings.filter((finding) => finding.state === "open");
  const sent = review.findings.filter((finding) => finding.state === "sent").length;
  const dismissed = review.findings.filter((finding) => finding.state === "dismissed");
  const resolved = review.findings.filter((finding) => finding.state !== "open");
  const place = (finding: ReviewFinding): PlacedFinding => ({ review, finding });

  const status =
    review.state === "running" ? (
      <span className="flex min-w-0 items-center gap-1.5 text-meta text-fg-secondary">
        <LoaderCircle size={12} strokeWidth={2} className="shrink-0 animate-spin" />
        <span className="truncate">Reading {review.label}…</span>
      </span>
    ) : review.state === "done" ? (
      <span className="truncate text-meta text-fg-tertiary">{findingsHeadline(review)}</span>
    ) : (
      <span className="truncate text-meta text-fg-tertiary">
        {review.state === "stopped" ? "Stopped" : "Failed"}
      </span>
    );

  return (
    <section
      aria-label={`Review by ${who}`}
      className={
        framed
          ? "overflow-hidden rounded-lg border border-line-subtle bg-surface-raised"
          : "border-t border-line-subtle"
      }
    >
      <header className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3">
        <Glasses size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden="true" />
        <span className="flex min-w-0 shrink items-center gap-1.5 text-body font-medium text-fg-primary">
          <ProviderLogo provider={review.reviewer.provider} size={12} className="shrink-0" />
          <span className="truncate">{who}</span>
        </span>
        <span className="min-w-0 flex-1 truncate">{status}</span>
        {review.state === "running" ? (
          <Button
            onClick={() => void stop({ payload: { reviewId: review.id } }).catch(() => undefined)}
            className={action}
          >
            Stop
          </Button>
        ) : open.length > 1 && actions.canSend ? (
          <Tooltip label="Adds every open finding to your message to the thread's agent">
            <Button
              onClick={() => open.forEach((finding) => actions.send(place(finding)))}
              className={action}
            >
              <Send size={12} strokeWidth={1.75} />
              Send all
            </Button>
          </Tooltip>
        ) : null}
      </header>
      {review.state === "failed" && review.message !== undefined ? (
        <p role="alert" className="border-t border-line-subtle px-3 py-2 text-meta text-error-text">
          {review.message}
        </p>
      ) : null}
      {review.summary === undefined || review.state !== "done" ? null : (
        <p className="border-t border-line-subtle px-3 py-2 text-meta leading-relaxed text-fg-secondary">
          <Prose text={review.summary} />
        </p>
      )}
      {open.length === 0 ? null : (
        <ul className="border-t border-line-subtle">
          {open.map((finding) => (
            <FindingRow key={finding.id} placed={place(finding)} actions={actions} />
          ))}
        </ul>
      )}
      {resolved.length === 0 ? null : (
        <div className="border-t border-line-subtle">
          <Button
            onClick={() => setShowResolved(!showResolved)}
            aria-expanded={showResolved}
            className="flex h-8 w-full cursor-default items-center gap-1 px-3 text-left text-meta text-fg-tertiary outline-none hover:bg-surface-hover hover:text-fg-secondary focus-visible:bg-surface-hover"
          >
            <ChevronRight
              size={12}
              strokeWidth={2}
              aria-hidden
              className={`shrink-0 transition-transform duration-150 ${showResolved ? "rotate-90" : ""}`}
            />
            {[
              sent > 0 ? `${sent} sent` : undefined,
              dismissed.length > 0 ? `${dismissed.length} dismissed` : undefined,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </Button>
          {showResolved ? (
            <ul>
              {resolved.map((finding) => (
                <li key={finding.id} className="flex items-center gap-2.5 py-1 pr-1.5 pl-3">
                  <SeverityDot severity={finding.severity} centred />
                  <span className="min-w-0 flex-1 truncate text-meta text-fg-tertiary" title={finding.title}>
                    {finding.title}
                  </span>
                  <span className="shrink-0 text-caption text-fg-tertiary">
                    {finding.state === "sent" ? "Sent" : "Dismissed"}
                  </span>
                  <Tooltip label="Show it again with the open findings">
                    <Button
                      onClick={() => actions.reopen(place(finding))}
                      aria-label="Reopen"
                      className={action}
                    >
                      <Undo2 size={12} strokeWidth={1.75} />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {review.state === "done" && review.findings.length === 0 && review.summary === undefined ? (
        <p className="border-t border-line-subtle px-3 py-2 text-meta text-fg-tertiary">
          Nothing to flag in {plural(review.files.length, "file")}.
        </p>
      ) : null}
    </section>
  );
}
