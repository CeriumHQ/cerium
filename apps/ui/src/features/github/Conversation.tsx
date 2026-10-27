import type {
  ConversationCommit,
  ConversationItem,
  GitHubAssociation,
  GitHubReaction,
  GitHubReference,
  GitHubUser,
  ReviewState,
} from "@cerium/rpc";
import {
  ArrowRightLeft,
  Bookmark,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Copy,
  Eye,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  GitPullRequestDraft,
  Link2,
  Lock,
  LockOpen,
  MessageSquare,
  Milestone,
  Pencil,
  Tag,
  Upload,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { Markdown } from "../transcript/Markdown.tsx";
import { foldConversation, referenceLabel, type ConversationEntry } from "./model.ts";
import { AssociationBadge, Avatar, GitHubLink, LabelChip, loginOf, Reactions, When } from "./parts.tsx";

// A pull request's or an issue's conversation as GitHub shows it: the description, then comments,
// reviews and what happened to it, in order. The pull request viewer puts each review's threads under
// it, and both viewers end it with their comment box.

/** The description, which opens the conversation as its first comment. */
export interface ConversationDescription {
  readonly author?: GitHubUser | undefined;
  readonly body: string;
  readonly at: number;
  readonly edited?: number | undefined;
  readonly association?: GitHubAssociation | undefined;
  readonly reactions: ReadonlyArray<GitHubReaction>;
  readonly url?: string | undefined;
}

export function Conversation({
  description,
  items,
  renderAfter,
  footer,
}: {
  description?: ConversationDescription | undefined;
  items: ReadonlyArray<ConversationItem>;
  /** What goes under an entry: a review's threads. */
  renderAfter?: ((item: ConversationItem) => ReactNode) | undefined;
  /** What ends it: the comment box, or a way to read on. */
  footer?: ReactNode;
}) {
  const entries = foldConversation(items);
  return (
    <ol className="flex flex-col gap-4">
      {description ? (
        <li>
          <CommentCard
            author={description.author}
            body={description.body}
            at={description.at}
            edited={description.edited}
            association={description.association}
            reactions={description.reactions}
            url={description.url}
            verb="opened this"
            empty="No description provided."
          />
        </li>
      ) : null}
      {entries.map((entry, index) => (
        <li key={entryKey(entry, index)} className="flex flex-col gap-3">
          <Entry entry={entry} />
          {entry._tag === "CommittedRun" ? null : renderAfter?.(entry)}
        </li>
      ))}
      {footer ? <li>{footer}</li> : null}
    </ol>
  );
}

const entryKey = (entry: ConversationEntry, index: number) =>
  entry._tag === "Comment" || entry._tag === "Review" ? entry.id : `${entry._tag}-${entry.at}-${index}`;

function Entry({ entry }: { entry: ConversationEntry }) {
  switch (entry._tag) {
    case "Comment":
      return (
        <CommentCard
          author={entry.author}
          body={entry.body}
          at={entry.at}
          edited={entry.edited}
          association={entry.association}
          reactions={entry.reactions}
          url={entry.url}
          hidden={entry.hidden}
          verb="commented"
        />
      );
    case "Review":
      return <ReviewEntry review={entry} />;
    case "Commits":
      return (
        <div className="flex flex-col gap-1.5">
          <EventRow icon={GitCommitHorizontal} actor={entry.actor} at={entry.at}>
            added {entry.commits.length === 1 ? "a commit" : `${entry.commits.length} commits`}
          </EventRow>
          <CommitList commits={entry.commits} />
        </div>
      );
    case "CommittedRun":
      return (
        <div className="flex gap-3">
          <EventIcon icon={GitCommitHorizontal} />
          <Disclosure
            summary={`${entry.commits.length} commits referenced this`}
            hint={<When at={entry.at} />}
            className="min-w-0 flex-1"
          >
            <ul className="flex flex-col gap-1">
              {entry.commits.map((commit) => (
                <li key={commit.oid} className="flex min-w-0 items-baseline gap-2 text-meta">
                  <GitHubLink
                    href={commit.url}
                    className="shrink-0 font-mono text-meta text-fg-tertiary hover:text-fg-primary"
                  >
                    {commit.oid.slice(0, 7)}
                  </GitHubLink>
                  <span className="min-w-0 truncate text-fg-secondary">{commit.headline}</span>
                  <span className="shrink-0 text-fg-tertiary">{loginOf(commit.actor)}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      );
    default:
      return <Event item={entry} />;
  }
}

/** A comment, or the description: who wrote it and when, then its Markdown and the reactions to it. */
export function CommentCard({
  author,
  body,
  at,
  edited,
  association,
  reactions,
  url,
  hidden,
  verb,
  empty = "No text.",
  avatar = true,
}: {
  author: GitHubUser | undefined;
  body: string;
  at: number;
  edited?: number | undefined;
  association?: GitHubAssociation | undefined;
  reactions: ReadonlyArray<GitHubReaction>;
  url?: string | undefined;
  /** A moderator hid it, for this reason; it shows folded. */
  hidden?: string | undefined;
  /** What the author did, after their name: "commented". */
  verb: string;
  /** What shows in place of an empty body. */
  empty?: string;
  /**
   * Its author's avatar leads it, and a line names them; a review's comment has both above it, so it
   * keeps the line only to unfold a hidden one.
   */
  avatar?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const folded = hidden !== undefined && !shown;
  return (
    <div className="flex gap-3">
      {avatar ? (
        <span className="pt-0.5">
          <Avatar user={author} size={28} />
        </span>
      ) : null}
      <article className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
        {!avatar && hidden === undefined ? null : (
          <header
            className={`flex min-h-9 flex-wrap items-center gap-x-1.5 gap-y-1 px-3.5 py-1.5 text-meta ${folded ? "" : "border-b border-line-subtle"}`}
          >
            <span className="font-medium text-fg-primary">{loginOf(author)}</span>
            <span className="text-fg-tertiary">
              {verb}{" "}
              {url === undefined ? (
                <When at={at} />
              ) : (
                <GitHubLink href={url} className="hover:text-fg-secondary hover:underline">
                  <When at={at} />
                </GitHubLink>
              )}
            </span>
            {edited === undefined ? null : <span className="text-fg-tertiary">· edited</span>}
            <span className="ml-auto flex items-center gap-2">
              <AssociationBadge association={association} />
              {hidden === undefined ? null : (
                <button
                  type="button"
                  onClick={() => setShown((current) => !current)}
                  className="rounded-md px-1.5 text-meta text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  {shown ? "Hide" : "Show"}
                </button>
              )}
            </span>
          </header>
        )}
        {folded ? (
          <p className="border-t border-line-subtle px-3.5 py-2 text-meta text-fg-tertiary">
            Hidden as {hidden.toLowerCase()}.
          </p>
        ) : (
          <>
            <div className="min-w-0 px-3.5 py-3">
              {body.trim() === "" ? (
                <p className="text-body text-fg-tertiary italic">{empty}</p>
              ) : (
                <Markdown text={body} streaming={false} />
              )}
            </div>
            {reactions.length === 0 ? null : (
              <div className="px-3.5 pb-3">
                <Reactions reactions={reactions} />
              </div>
            )}
          </>
        )}
      </article>
    </div>
  );
}

const verdict: Record<ReviewState, { icon: LucideIcon; tone: string; words: string }> = {
  approved: { icon: CircleCheck, tone: "text-success-text", words: "approved these changes" },
  changesRequested: { icon: FileDiff, tone: "text-error-text", words: "requested changes" },
  commented: { icon: Eye, tone: "text-fg-tertiary", words: "reviewed" },
  dismissed: { icon: CircleSlash, tone: "text-fg-tertiary", words: "reviewed (dismissed)" },
  pending: { icon: Eye, tone: "text-attention-text", words: "started a review" },
};

type Review = Extract<ConversationItem, { readonly _tag: "Review" }>;

/** A review: its verdict as an event, then what the reviewer wrote with it, if anything. */
function ReviewEntry({ review }: { review: Review }) {
  const { icon, tone, words } = verdict[review.state];
  return (
    <div className="flex flex-col gap-2">
      <EventRow icon={icon} tone={tone} actor={review.author} at={review.at} url={review.url}>
        {words}
      </EventRow>
      {review.body.trim() === "" ? null : (
        <div className="pl-10">
          <CommentCard
            author={review.author}
            body={review.body}
            at={review.at}
            edited={review.edited}
            association={review.association}
            reactions={review.reactions}
            hidden={review.hidden}
            verb="wrote"
            avatar={false}
          />
        </div>
      )}
    </div>
  );
}

/** The icon an event leads with, in the column the comments' avatars take. */
function EventIcon({ icon: Icon, tone = "text-fg-tertiary" }: { icon: LucideIcon; tone?: string }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center">
      <span className={`grid size-6 place-items-center rounded-full bg-surface-hover ${tone}`}>
        <Icon size={13} strokeWidth={2} />
      </span>
    </span>
  );
}

/** Something that happened, in a line: who did it, what, and when. */
function EventRow({
  icon,
  tone,
  actor,
  at,
  url,
  children,
}: {
  icon: LucideIcon;
  tone?: string;
  actor: GitHubUser | undefined;
  at: number;
  url?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <EventIcon icon={icon} {...(tone ? { tone } : {})} />
      <p className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-meta leading-5 text-fg-secondary">
        <span className="inline-flex items-center gap-1.5">
          <Avatar user={actor} size={16} />
          <span className="font-medium text-fg-primary">{loginOf(actor)}</span>
        </span>
        {children}
        <span className="text-fg-tertiary">
          ·{" "}
          {url === undefined ? (
            <When at={at} />
          ) : (
            <GitHubLink href={url} className="hover:text-fg-secondary hover:underline">
              <When at={at} />
            </GitHubLink>
          )}
        </span>
      </p>
    </div>
  );
}

/** Commits pushed in one go, each with its headline and a link to it. */
function CommitList({ commits }: { commits: ReadonlyArray<ConversationCommit> }) {
  return (
    <ul className="ml-10 flex flex-col overflow-hidden rounded-lg border border-line-subtle">
      {commits.map((commit) => (
        <li
          key={commit.oid}
          className="flex min-w-0 items-center gap-2 border-line-subtle px-3 py-1.5 text-meta not-first:border-t"
        >
          <Avatar user={commit.author} size={16} />
          <span className="min-w-0 flex-1 truncate text-fg-primary" title={commit.headline}>
            {commit.headline}
          </span>
          <GitHubLink
            href={commit.url}
            className="shrink-0 font-mono text-meta text-fg-tertiary hover:text-fg-primary"
          >
            {commit.oid.slice(0, 7)}
          </GitHubLink>
        </li>
      ))}
    </ul>
  );
}

/** Another issue or pull request, linked out: its title and number. */
function Reference({ reference }: { reference: GitHubReference }) {
  return (
    <GitHubLink href={reference.url} className="min-w-0 text-fg-primary hover:underline">
      {reference.title} <span className="text-fg-tertiary">{referenceLabel(reference)}</span>
    </GitHubLink>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-surface-hover px-1 font-mono text-meta text-fg-primary">{children}</code>
);

const names = (logins: ReadonlyArray<string>) => (
  <span className="font-medium text-fg-primary">{logins.join(", ")}</span>
);

type EventItem = Exclude<ConversationItem, { readonly _tag: "Comment" | "Review" | "Commits" }>;

/** An event in its line: the icon and the words for it. */
function Event({ item }: { item: EventItem }) {
  const row = (icon: LucideIcon, children: ReactNode, tone?: string) => (
    <EventRow icon={icon} actor={item.actor} at={item.at} {...(tone ? { tone } : {})}>
      {children}
    </EventRow>
  );
  switch (item._tag) {
    case "Labels":
      return row(
        Tag,
        <>
          {item.added.length > 0 ? "added" : null}
          {item.added.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
          {item.added.length > 0 && item.removed.length > 0 ? "and" : null}
          {item.removed.length > 0 ? "removed" : null}
          {item.removed.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </>,
      );
    case "Assignees": {
      const self = item.actor !== undefined && item.added.length === 1 && item.added[0] === item.actor.login;
      return row(
        UserRound,
        self && item.removed.length === 0 ? (
          "self-assigned this"
        ) : (
          <>
            {item.added.length > 0 ? <>assigned {names(item.added)}</> : null}
            {item.added.length > 0 && item.removed.length > 0 ? " and " : null}
            {item.removed.length > 0 ? <>unassigned {names(item.removed)}</> : null}
          </>
        ),
      );
    }
    case "Closed":
      return row(
        item.reason === "notPlanned" ? CircleSlash : CircleCheck,
        <>
          closed this
          {item.reason === "notPlanned"
            ? " as not planned"
            : item.reason === "duplicate"
              ? " as a duplicate"
              : ""}
          {item.by === undefined ? null : (
            <>
              {" "}
              in <GitHubLink href={item.by.url}>{item.by.label}</GitHubLink>
            </>
          )}
        </>,
        item.reason === "notPlanned" ? "text-fg-tertiary" : "text-merged",
      );
    case "Reopened":
      return row(CircleDot, "reopened this", "text-success-text");
    case "Renamed":
      return row(
        Pencil,
        <>
          changed the title <span className="text-fg-tertiary line-through">{item.from}</span>
          <span className="text-fg-primary">{item.to}</span>
        </>,
      );
    case "Milestone":
      return row(
        Milestone,
        item.removed ? (
          <>
            removed this from the <span className="font-medium text-fg-primary">{item.title}</span> milestone
          </>
        ) : (
          <>
            added this to the <span className="font-medium text-fg-primary">{item.title}</span> milestone
          </>
        ),
      );
    case "Referenced":
      return row(
        Bookmark,
        <>
          {item.closes ? "linked" : "mentioned this in"} <Reference reference={item.by} />
          {item.closes ? " that will close this" : null}
        </>,
      );
    case "Committed":
      return row(
        GitCommitHorizontal,
        <>
          referenced this in commit{" "}
          <GitHubLink href={item.url} className="font-mono text-meta text-fg-primary hover:underline">
            {item.oid.slice(0, 7)}
          </GitHubLink>
          <span className="min-w-0 truncate text-fg-tertiary">{item.headline}</span>
        </>,
      );
    case "Locked":
      return row(
        item.locked ? Lock : LockOpen,
        item.locked
          ? `locked${item.reason === undefined ? "" : ` as ${item.reason.toLowerCase().replaceAll("_", " ")}`} and limited conversation to collaborators`
          : "unlocked this conversation",
      );
    case "Linked":
      return row(
        Link2,
        item.unlinked ? (
          <>
            removed a link to <Reference reference={item.subject} />
          </>
        ) : (
          <>
            linked <Reference reference={item.subject} />
          </>
        ),
      );
    case "Duplicate":
      return row(
        Copy,
        <>
          marked this as a duplicate of <Reference reference={item.of} />
        </>,
      );
    case "Transferred":
      return row(
        ArrowRightLeft,
        <>
          transferred this from <span className="font-medium text-fg-primary">{item.from}</span>
        </>,
      );
    case "ReviewRequested":
      return row(
        Eye,
        item.removed ? (
          <>removed the request for review from {names([item.reviewer])}</>
        ) : (
          <>requested a review from {names([item.reviewer])}</>
        ),
      );
    case "Merged":
      return row(
        GitMerge,
        <>
          merged commit{" "}
          <GitHubLink href={item.url} className="font-mono text-meta text-fg-primary hover:underline">
            {item.oid.slice(0, 7)}
          </GitHubLink>{" "}
          into <Code>{item.base}</Code>
        </>,
        "text-merged",
      );
    case "Draft":
      return item.draft
        ? row(GitPullRequestDraft, "marked this as a draft")
        : row(Eye, "marked this ready for review");
    case "ForcePushed":
      return row(
        Upload,
        <>
          force-pushed the branch
          {item.before === undefined || item.after === undefined ? null : (
            <>
              {" "}
              from <Code>{item.before.slice(0, 7)}</Code> to <Code>{item.after.slice(0, 7)}</Code>
            </>
          )}
        </>,
      );
    case "Branch":
      return row(GitBranch, item.deleted ? "deleted the head branch" : "restored the head branch");
    case "BaseChanged":
      return row(
        GitCompareArrows,
        <>
          changed the base branch from <Code>{item.from}</Code> to <Code>{item.to}</Code>
        </>,
      );
  }
}

/** The quiet icon conversations use for a plain comment, for whoever lists them. */
export const CommentIcon = MessageSquare;
