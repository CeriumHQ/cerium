import type { GitHubAssociation, GitHubLabel, GitHubReaction, GitHubUser, ReactionKind } from "@cerium/rpc";
import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { whenAgo } from "../../lib/time.ts";
import { labelColor, pullStateLabel, type PullStateKind } from "./model.ts";

const pullStateLook: Record<PullStateKind, { icon: LucideIcon; tone: string }> = {
  open: { icon: GitPullRequestArrow, tone: "text-success" },
  draft: { icon: GitPullRequestDraft, tone: "text-fg-tertiary" },
  closed: { icon: GitPullRequestClosed, tone: "text-error" },
  merged: { icon: GitMerge, tone: "text-merged" },
};

/** GitHub's mark (Primer Octicons' `mark-github`, MIT), where GitHub itself is named. */
export function GitHubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** A pull request's state as GitHub draws it: its icon in its colour. */
export function PullStateIcon({ state, size = 15 }: { state: PullStateKind; size?: number }) {
  const { icon: Icon, tone } = pullStateLook[state];
  return (
    <Icon size={size} strokeWidth={2} aria-label={pullStateLabel[state]} className={`shrink-0 ${tone}`} />
  );
}

/** A pull request's state as a badge, for the viewer's header. */
export function PullStateBadge({ state }: { state: PullStateKind }) {
  const { icon: Icon, tone } = pullStateLook[state];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-current/30 bg-current/10 px-2.5 text-[12px] font-medium ${tone}`}
    >
      <Icon size={13} strokeWidth={2} />
      {pullStateLabel[state]}
    </span>
  );
}

// The small pieces GitHub's pull requests and issues are drawn from: people, labels, times and
// reactions, alike in the lists, the viewers and their conversations.

/** A GitHub avatar at `size` pixels, asked for at twice that; the login's first letter until it loads. */
export function Avatar({ user, size = 20 }: { user: GitHubUser | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = user?.avatarUrl;
  const style = { width: size, height: size };
  if (url === undefined || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.45)) }}
        className="grid shrink-0 place-items-center rounded-full bg-surface-hover font-medium text-fg-tertiary uppercase select-none"
      >
        {user?.login.charAt(0) ?? "?"}
      </span>
    );
  }
  const sized = `${url}${url.includes("?") ? "&" : "?"}s=${size * 2}`;
  return (
    <img
      src={sized}
      alt=""
      style={style}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-surface-hover outline -outline-offset-1 outline-line-subtle"
    />
  );
}

/** A login as conversations name it; GitHub calls a deleted account "ghost". */
export const loginOf = (user: GitHubUser | undefined) => user?.login ?? "ghost";

/** A label: its colour as a dot, its name in the panel's own type, its description on hover. */
export function LabelChip({ label }: { label: GitHubLabel }) {
  const chip = (
    <span className="inline-flex h-5 max-w-48 shrink-0 items-center gap-1.5 rounded-full border border-line-subtle px-2 text-[11.5px] text-fg-secondary">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: labelColor(label.color) }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
  return label.description === undefined || label.description === "" ? (
    chip
  ) : (
    <Tooltip label={label.description}>{chip}</Tooltip>
  );
}

const fullDate = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When something happened, as people say it, the exact time on hover. */
export function When({ at, className }: { at: number; className?: string }) {
  return (
    <Tooltip label={fullDate(at)}>
      <time dateTime={new Date(at).toISOString()} className={className}>
        {whenAgo(at)}
      </time>
    </Tooltip>
  );
}

const associationWord: Partial<Record<GitHubAssociation, string>> = {
  owner: "Owner",
  member: "Member",
  collaborator: "Collaborator",
  contributor: "Contributor",
  firstTimer: "First-time contributor",
};

/** How the author is tied to the repository, as a quiet badge; nothing for anyone else. */
export function AssociationBadge({ association }: { association: GitHubAssociation | undefined }) {
  const word = association === undefined ? undefined : associationWord[association];
  if (word === undefined) return null;
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-line-subtle px-1.5 text-[11px] text-fg-tertiary">
      {word}
    </span>
  );
}

const reactionEmoji: Record<ReactionKind, string> = {
  thumbsUp: "👍",
  thumbsDown: "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const reactionWord: Record<ReactionKind, string> = {
  thumbsUp: "+1",
  thumbsDown: "-1",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

/** The reactions something has, each kind with its count; the user's own picked out. */
export function Reactions({ reactions }: { reactions: ReadonlyArray<GitHubReaction> }) {
  if (reactions.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Reactions">
      {reactions.map((reaction) => (
        <li
          key={reaction.kind}
          aria-label={`${reaction.count} ${reactionWord[reaction.kind]}${reaction.mine ? ", yours among them" : ""}`}
          className={`flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums ${
            reaction.mine
              ? "border-accent/40 bg-accent-soft text-fg-primary"
              : "border-line-subtle text-fg-secondary"
          }`}
        >
          <span aria-hidden="true" className="text-[13px] leading-none">
            {reactionEmoji[reaction.kind]}
          </span>
          {reaction.count}
        </li>
      ))}
    </ul>
  );
}

/** A link out to GitHub, in the browser. */
export function GitHubLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className ?? "text-fg-primary underline-offset-2 hover:underline"}
    >
      {children}
    </a>
  );
}
