import { Button } from "@base-ui/react/button";
import type {
  ChangedFile,
  PullRequestCheck,
  PullRequestCommit,
  PullRequestDetail,
  ReviewThread,
} from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleSlash,
  CircleX,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  pullCommitsAtom,
  pullChecksAtom,
  pullFilesAtom,
  pullHeadKey,
  pullKey,
} from "../../backend/github.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { shortAgo } from "../../lib/time.ts";
import { LINE_HEIGHT } from "../viewer/CodeView.tsx";
import type { DiffLayout } from "../viewer/DiffView.tsx";
import { DiffView } from "../viewer/DiffView.tsx";
import type { NumberedLine } from "../viewer/model.ts";
import { failureMessage } from "./model.ts";
import { Avatar, GitHubLink } from "./parts.tsx";
import { ChecksMark } from "./PullRequestList.tsx";
import { ReviewThreadCard } from "./ReviewThreadCard.tsx";
import type { PullActions } from "./usePullRequest.ts";

// The pull request viewer's other tabs: its commits, its checks, and the files it changes with the
// review threads on their lines.

function Waiting({ children }: { children: string }) {
  return <p className="px-6 py-10 text-center text-meta text-fg-tertiary">{children}</p>;
}

function Failed({ children }: { children: string }) {
  return <p className="px-6 py-10 text-center text-meta text-error">{children}</p>;
}

// ---------------------------------------------------------------------------------------------
// Commits

export function PullCommits({ cwd, pull }: { cwd: string; pull: PullRequestDetail }) {
  const result = useAtomValue(pullCommitsAtom(pullHeadKey(pullKey(cwd, pull.number), pull.headOid)));
  const page = AsyncResult.getOrElse(result, () => undefined);
  if (page === undefined) {
    return AsyncResult.isFailure(result) ? (
      <Failed>{failureMessage(result.cause, "The commits couldn't be read.")}</Failed>
    ) : (
      <Waiting>Reading the commits…</Waiting>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
        {page.commits.map((commit) => (
          <CommitRow key={commit.oid} commit={commit} />
        ))}
      </ol>
      {page.next === undefined ? null : (
        <p className="text-center text-meta text-fg-tertiary">
          The first {page.commits.length} of {pull.commitCount} commits.{" "}
          <GitHubLink href={`${pull.url}/commits`}>See them all on GitHub</GitHubLink>
        </p>
      )}
    </div>
  );
}

function CommitRow({ commit }: { commit: PullRequestCommit }) {
  const [open, setOpen] = useState(false);
  const body = commit.body?.trim() ?? "";
  return (
    <li className="flex flex-col border-line-subtle not-first:border-t">
      <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5">
        <Avatar user={commit.author} size={20} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-body text-fg-primary" title={commit.headline}>
              {commit.headline}
            </span>
            {body === "" ? null : (
              <Button
                onClick={() => setOpen((current) => !current)}
                aria-expanded={open}
                aria-label={open ? "Hide the message" : "Show the message"}
                className="grid h-4 shrink-0 place-items-center rounded bg-surface-hover px-1 text-[10px] leading-none text-fg-tertiary hover:text-fg-primary"
              >
                …
              </Button>
            )}
          </span>
          <span className="text-meta text-fg-tertiary">
            {commit.author?.login ?? commit.authorName ?? "Someone"} · {shortAgo(commit.at)}
          </span>
        </div>
        {commit.checks === undefined ? null : <ChecksMark state={commit.checks} />}
        <GitHubLink
          href={commit.url}
          className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-meta text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          {commit.oid.slice(0, 7)}
        </GitHubLink>
      </div>
      {open ? (
        <pre className="mx-3.5 mb-3 ml-[2.875rem] font-mono text-meta leading-relaxed whitespace-pre-wrap text-fg-secondary">
          {body}
        </pre>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Checks

const checkLook: Record<PullRequestCheck["state"], { icon: LucideIcon; tone: string; word: string }> = {
  failure: { icon: CircleX, tone: "text-error", word: "Failed" },
  actionRequired: { icon: CircleX, tone: "text-attention", word: "Action required" },
  pending: { icon: CircleDashed, tone: "text-attention", word: "Running" },
  success: { icon: CircleCheck, tone: "text-success", word: "Passed" },
  neutral: { icon: CircleMinus, tone: "text-fg-tertiary", word: "Neutral" },
  skipped: { icon: CircleSlash, tone: "text-fg-tertiary", word: "Skipped" },
  cancelled: { icon: CircleSlash, tone: "text-fg-tertiary", word: "Cancelled" },
};

const took = (check: PullRequestCheck) => {
  if (check.startedAt === undefined || check.completedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((check.completedAt - check.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export function PullChecks({ cwd, pull }: { cwd: string; pull: PullRequestDetail }) {
  const result = useAtomValue(pullChecksAtom(pullKey(cwd, pull.number)));
  const checks = AsyncResult.getOrElse(result, () => undefined);
  if (checks === undefined) {
    return AsyncResult.isFailure(result) ? (
      <Failed>{failureMessage(result.cause, "The checks couldn't be read.")}</Failed>
    ) : (
      <Waiting>Reading the checks…</Waiting>
    );
  }
  if (checks.checks.length === 0) return <Waiting>No checks ran on the latest commit.</Waiting>;
  const count = (states: ReadonlyArray<PullRequestCheck["state"]>) =>
    checks.checks.filter((check) => states.includes(check.state)).length;
  const failed = count(["failure", "actionRequired"]);
  const running = count(["pending"]);
  const passed = count(["success"]);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta text-fg-secondary">
        {[
          failed > 0 ? `${failed} failed` : undefined,
          running > 0 ? `${running} running` : undefined,
          passed > 0 ? `${passed} passed` : undefined,
          checks.checks.length - failed - running - passed > 0
            ? `${checks.checks.length - failed - running - passed} skipped or neutral`
            : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" · ")}
      </p>
      <ul className="flex flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
        {checks.checks.map((check, index) => {
          const { icon: Icon, tone, word } = checkLook[check.state];
          const duration = took(check);
          return (
            <li
              key={`${check.group ?? ""}/${check.name}/${index}`}
              className="flex min-w-0 items-center gap-2.5 border-line-subtle px-3.5 py-2.5 not-first:border-t"
            >
              <Icon size={15} strokeWidth={2} aria-label={word} className={`shrink-0 ${tone}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-body">
                  {check.group === undefined ? null : (
                    <span className="shrink-0 text-fg-tertiary">{check.group} /</span>
                  )}
                  <span className="min-w-0 truncate text-fg-primary">{check.name}</span>
                  {check.required ? (
                    <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-line-subtle px-1.5 text-caption text-fg-tertiary">
                      Required
                    </span>
                  ) : null}
                </span>
                {check.description === undefined && duration === undefined ? null : (
                  <span className="min-w-0 truncate text-meta text-fg-tertiary">
                    {[check.description, duration].filter((part) => part !== undefined).join(" · ")}
                  </span>
                )}
              </div>
              {check.url === undefined ? null : (
                <GitHubLink
                  href={check.url}
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-meta text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  Details
                  <ExternalLink size={11} strokeWidth={2} />
                </GitHubLink>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Files

/** A file with more changed lines than this starts folded, so a large pull request opens quickly. */
const FOLD_LINES = 400;

const fileStatusWord: Record<ChangedFile["status"], string> = {
  added: "Added",
  removed: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  copied: "Copied",
  changed: "Changed",
};

/** How far from the view a file's diff starts drawing, so it's drawn by the time it scrolls in. */
const NEAR = "1500px";

/** The nearest ancestor that scrolls `element`, which a margin around the view must reach past. */
const scrollerOf = (element: Element): Element | null => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
};

/**
 * Draws `children` once they near the view, and keeps them drawn: a pull request of many files opens
 * without drawing every diff at once. Until then a space about their height holds their place.
 */
function WhenNear({ height, children }: { height: number; children: ReactNode }) {
  const [near, setNear] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = holder.current;
    if (near || target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: scrollerOf(target), rootMargin: NEAR },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [near]);
  return near ? children : <div ref={holder} style={{ height }} />;
}

/** The threads on each file, by path. */
const threadsByPath = (threads: ReadonlyArray<ReviewThread>) => {
  const byPath = new Map<string, Array<ReviewThread>>();
  for (const thread of threads) byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
  return byPath;
};

export function PullFiles({
  cwd,
  pull,
  layout,
  actions,
}: {
  cwd: string;
  pull: PullRequestDetail;
  layout: DiffLayout;
  actions: PullActions;
}) {
  const result = useAtomValue(pullFilesAtom(pullHeadKey(pullKey(cwd, pull.number), pull.headOid)));
  const files = AsyncResult.getOrElse(result, () => undefined);
  if (files === undefined) {
    return AsyncResult.isFailure(result) ? (
      <Failed>{failureMessage(result.cause, "The changed files couldn't be read.")}</Failed>
    ) : (
      <Waiting>Reading the changes…</Waiting>
    );
  }
  const threads = threadsByPath(pull.threads);
  return (
    <div className="flex flex-col gap-3">
      {files.files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          threads={threads.get(file.path) ?? []}
          layout={layout}
          actions={actions}
        />
      ))}
      {files.truncated === true ? (
        <p className="text-center text-meta text-fg-tertiary">
          GitHub sends the first {files.files.length} files of {pull.changedFiles}.{" "}
          <GitHubLink href={`${pull.url}/files`}>See them all on GitHub</GitHubLink>
        </p>
      ) : null}
    </div>
  );
}

/** One changed file: its header, then its diff with the review threads on their lines. */
function FileDiff({
  file,
  threads,
  layout,
  actions,
}: {
  file: ChangedFile;
  threads: ReadonlyArray<ReviewThread>;
  layout: DiffLayout;
  actions: PullActions;
}) {
  const [open, setOpen] = useState(
    file.additions + file.deletions <= FOLD_LINES && file.status !== "removed",
  );
  /** A file that starts open draws its diff as it nears the view; one the user opens is in view already. */
  const [lazy, setLazy] = useState(open);
  // A thread goes under the line it's on, on its side of the diff; one the diff no longer shows goes above.
  const placed = new Map<string, Array<ReviewThread>>();
  const placeable = new Set<string>();
  for (const hunk of file.hunks) {
    let old = Math.max(hunk.oldStart, 1);
    let next = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind !== "added") placeable.add(`old:${old++}`);
      if (line.kind !== "removed") placeable.add(`new:${next++}`);
    }
  }
  const loose: Array<ReviewThread> = [];
  for (const thread of threads) {
    const at = thread.line === undefined ? undefined : `${thread.side}:${thread.line}`;
    if (at !== undefined && !thread.outdated && placeable.has(at))
      placed.set(at, [...(placed.get(at) ?? []), thread]);
    else loose.push(thread);
  }
  const after = (line: NumberedLine) => {
    const here = [
      ...(line.kind !== "added" && line.old !== undefined ? (placed.get(`old:${line.old}`) ?? []) : []),
      ...(line.kind !== "removed" && line.new !== undefined ? (placed.get(`new:${line.new}`) ?? []) : []),
    ];
    if (here.length === 0) return null;
    return (
      <div className="flex flex-col gap-2 border-y border-line-subtle bg-surface-window px-3 py-2.5">
        {here.map((thread) => (
          <ReviewThreadCard key={thread.id} thread={thread} actions={actions} snippet={false} />
        ))}
      </div>
    );
  };
  const name = file.path.split("/").at(-1) ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);
  const diff = (
    <DiffView
      hunks={file.hunks}
      path={file.path}
      layout={layout}
      onExpand={undefined}
      scroll={false}
      after={after}
    />
  );
  return (
    <section className="overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
      <Button
        onClick={() => {
          setOpen((current) => !current);
          setLazy(false);
        }}
        aria-expanded={open}
        className={`sticky top-0 z-10 flex min-h-10 w-full items-center gap-2 bg-surface-raised px-3 py-2 text-left transition-colors hover:bg-surface-hover ${open ? "border-b border-line-subtle" : ""}`}
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          className={`shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <FileIcon path={file.path} className="size-4 shrink-0" />
        <span className="flex min-w-0 items-baseline gap-0 font-mono text-meta">
          <span className="min-w-0 truncate text-fg-tertiary">{folder}</span>
          <span className="shrink-0 text-fg-primary">{name}</span>
        </span>
        {file.from === undefined ? null : (
          <span className="min-w-0 truncate font-mono text-meta text-fg-tertiary" title={file.from}>
            from {file.from}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-meta tabular-nums">
          {threads.length > 0 ? (
            <span className="text-fg-tertiary">
              {threads.length === 1 ? "1 thread" : `${threads.length} threads`}
            </span>
          ) : null}
          {file.status === "modified" ? null : (
            <span className="text-fg-tertiary">{fileStatusWord[file.status]}</span>
          )}
          <span className="font-mono">
            <span className="text-success">+{file.additions}</span>{" "}
            <span className="text-error">−{file.deletions}</span>
          </span>
        </span>
      </Button>
      {open ? (
        <>
          {loose.length > 0 ? (
            <div className="flex flex-col gap-2 border-b border-line-subtle bg-surface-window px-3 py-2.5">
              {loose.map((thread) => (
                <ReviewThreadCard key={thread.id} thread={thread} actions={actions} />
              ))}
            </div>
          ) : null}
          {file.noDiff === true || file.hunks.length === 0 ? (
            <p className="px-4 py-4 text-meta text-fg-tertiary">
              {file.noDiff === true
                ? "GitHub doesn't show this file's changes: it's binary, or too large."
                : "No changes to show."}
            </p>
          ) : lazy ? (
            <WhenNear height={file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) * LINE_HEIGHT}>
              {diff}
            </WhenNear>
          ) : (
            diff
          )}
        </>
      ) : null}
    </section>
  );
}
