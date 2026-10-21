import { Button } from "@base-ui/react/button";
import type { GitHubAssociation, GitHubLabel, GitHubReaction, GitHubUser, ReactionKind } from "@cerium/rpc";
import {
  ChevronDown,
  Ellipsis,
  GitBranch,
  GitMerge,
  MessageSquarePlus,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
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
  return <StatePill icon={<Icon size={13} strokeWidth={2} />} label={pullStateLabel[state]} tone={tone} />;
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

/**
 * A label: its colour as a dot, its name in the panel's own type, its description on hover. One that
 * `fits` gives up width to its line, its name cut short, rather than wrapping the line.
 */
export function LabelChip({ label, fits = false }: { label: GitHubLabel; fits?: boolean }) {
  const chip = (
    <span
      className={`inline-flex h-5 max-w-48 items-center gap-1.5 rounded-full border border-line-subtle px-2 text-[11.5px] text-fg-secondary ${fits ? "min-w-0 shrink" : "shrink-0"}`}
    >
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

/** Labels a list row shows before it counts the rest. */
const LABELS_SHOWN = 2;

/** A row's labels on a single line, the first few and a count of the rest. */
function LabelLine({ labels }: { labels: ReadonlyArray<GitHubLabel> }) {
  const hidden = labels.length - LABELS_SHOWN;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden pt-1">
      {labels.slice(0, LABELS_SHOWN).map((label) => (
        <LabelChip key={label.name} label={label} fits />
      ))}
      {hidden > 0 ? (
        <span className="shrink-0 text-[11.5px] text-fg-tertiary tabular-nums">+{hidden}</span>
      ) : null}
    </span>
  );
}

/**
 * A pull request or an issue in the GitHub panel's lists, alike in both: its state, its title, a line
 * of facts with its marks (comments, checks, who it's assigned to) at the end, then its labels.
 */
export function ItemRow({
  icon,
  title,
  facts,
  marks,
  labels,
  current,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  /** Its number, author and age, left on the line under the title. */
  facts: ReactNode;
  /** What it has going on, right on that line. */
  marks?: ReactNode;
  labels: ReadonlyArray<GitHubLabel>;
  /** Its tab is the one showing. */
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen();
      }}
      aria-current={current ? "page" : undefined}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset aria-[current=page]:bg-surface-selected max-md:py-3"
    >
      <span className="grid h-[18px] shrink-0 place-items-center max-md:h-5">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-[13px] leading-[18px] text-fg-primary max-md:text-[15px] max-md:leading-5">
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-fg-tertiary max-md:text-[13px]">
          <span className="flex min-w-0 items-center gap-1.5">{facts}</span>
          {marks === undefined ? null : (
            <span className="ml-auto flex shrink-0 items-center gap-2">{marks}</span>
          )}
        </span>
        {labels.length === 0 ? null : <LabelLine labels={labels} />}
      </span>
    </button>
  );
}

/** A count of comments, as a row's mark. */
export function CommentCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 tabular-nums" aria-label={`${count} comments`}>
      <MessageSquare size={11} strokeWidth={2} aria-hidden="true" />
      {count}
    </span>
  );
}

/** A pull request's or an issue's state as a pill, in the viewer's title: its icon and word in its colour. */
export function StatePill({ icon, label, tone }: { icon: ReactNode; label: string; tone: string }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-current/12 px-2.5 text-[12px] font-medium ${tone}`}
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * A pull request's or an issue's title at the top of its tab, its number beside it, and under it a line
 * of what it is: its state, who opened it and when, what else there is to know. The line's parts wrap
 * as wholes in a narrow pane.
 */
export function ViewerTitle({
  title,
  number,
  children,
}: {
  title: string;
  number: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-[20px] leading-snug font-semibold tracking-tight text-pretty text-fg-primary max-md:text-[19px]">
        {title} <span className="font-normal text-fg-tertiary tabular-nums">#{number}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] leading-6 text-fg-tertiary max-md:text-[14px]">
        {children}
      </div>
    </div>
  );
}

/** A branch or other name of git's in a viewer's line of text. */
export function CodeName({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-surface-hover px-1.5 py-px font-mono text-[12px] text-fg-secondary">
      {children}
    </code>
  );
}

/**
 * The viewer's way to start a thread that looks into what it shows: quiet beside the tabs, and where a
 * thread can have a worktree, a menu for where it starts. On a phone only its icon shows.
 */
export function StartThreadButton({
  worktrees,
  disabled = false,
  onStart,
}: {
  worktrees: boolean;
  disabled?: boolean;
  onStart: (worktree: boolean) => void;
}) {
  return (
    <div className="flex items-center">
      <Tooltip
        label={
          worktrees
            ? "Start a thread to look into it, in a worktree of its own"
            : "Start a thread to look into it"
        }
      >
        <Button
          aria-label="Start thread"
          disabled={disabled}
          onClick={() => onStart(worktrees)}
          className={`flex h-7 items-center gap-1.5 border border-line-strong px-2 text-[12.5px] font-medium text-fg-primary transition-colors hover:bg-surface-hover disabled:opacity-40 max-md:h-10 max-md:px-3 ${worktrees ? "rounded-l-md border-r-0" : "rounded-md"}`}
        >
          <MessageSquarePlus size={13} strokeWidth={1.75} className="shrink-0 max-md:size-4" />
          <span className="max-md:hidden">Start thread</span>
        </Button>
      </Tooltip>
      {worktrees ? (
        <MenuRoot>
          <MenuTrigger>
            <Button
              aria-label="Where the thread starts"
              disabled={disabled}
              className="grid h-7 w-6 place-items-center rounded-r-md border border-line-strong text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:opacity-40 data-popup-open:bg-surface-hover max-md:h-10 max-md:w-8"
            >
              <ChevronDown size={13} strokeWidth={2} />
            </Button>
          </MenuTrigger>
          <MenuPopup>
            <MenuItem icon={GitBranch} onClick={() => onStart(true)}>
              In a worktree of its own
            </MenuItem>
            <MenuItem icon={MessageSquare} onClick={() => onStart(false)}>
              In the project's folder
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      ) : null}
    </div>
  );
}

/**
 * The box at the end of a conversation, drawn as the thread's message box is: what's written, then
 * the buttons that send it, inside the same card. Ctrl Enter comments. What went wrong shows under it.
 */
export function CommentBox({
  value,
  onChange,
  onComment,
  placeholder = "Leave a comment",
  disabled = false,
  error,
  onDismiss,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  onComment: () => void;
  placeholder?: string;
  disabled?: boolean;
  error: string | undefined;
  onDismiss: () => void;
  /** The buttons, the one that comments last. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col rounded-xl border border-line-subtle bg-surface-raised transition-colors focus-within:border-line-strong">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onComment();
            }
          }}
          placeholder={placeholder}
          aria-label="Comment"
          spellCheck
          disabled={disabled}
          className="scroll-thin max-h-72 min-h-16 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13px] leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary disabled:opacity-60 max-md:text-[15px]"
        />
        <div className="flex flex-wrap items-center justify-end gap-1.5 p-2">{children}</div>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="flex items-start gap-2 px-1 text-[12.5px] text-error max-md:text-[14px]">
          <span className="min-w-0 flex-1 text-balance">{error}</span>
          <Button
            aria-label="Dismiss"
            onClick={onDismiss}
            className="grid size-4 shrink-0 place-items-center rounded text-error/70 hover:text-error"
          >
            <X size={12} strokeWidth={2} />
          </Button>
        </p>
      )}
    </div>
  );
}

/** The viewer's More button, its menu given. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <MenuRoot>
      <Tooltip label="More">
        <MenuTrigger>
          <Button
            aria-label="More"
            className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active data-popup-open:bg-surface-hover max-md:size-10"
          >
            <Ellipsis size={15} strokeWidth={1.75} />
          </Button>
        </MenuTrigger>
      </Tooltip>
      <MenuPopup>{children}</MenuPopup>
    </MenuRoot>
  );
}

/**
 * What sets a pull request or an issue apart from its conversation, as a quiet list of facts: the
 * name of each on the left, its people, labels or links on the right, and a way to change it beside the
 * name where there's one.
 */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col gap-1.5 text-[12.5px] max-md:text-[14px]">{children}</dl>;
}

export function Fact({ name, action, children }: { name: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 max-md:flex-col max-md:gap-1">
      <dt className="flex h-6 w-24 shrink-0 items-center justify-between gap-1 text-fg-tertiary max-md:w-auto">
        {name}
        {action}
      </dt>
      <dd className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-fg-secondary">
        {children}
      </dd>
    </div>
  );
}

/** A person among a fact's people: their avatar and login, with what they did after it. */
export function PersonChip({ user, children }: { user: GitHubUser | undefined; children?: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-subtle py-0.5 pr-2 pl-0.5">
      <Avatar user={user} size={20} />
      <span className="text-fg-primary">{loginOf(user)}</span>
      {children}
    </span>
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
