import type { Commit, CommitPage } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { commitPageAtom, commitPageKey, historyVersionAtom } from "../../../backend/history.ts";
import { Note, messageOf } from "../../viewer/previews.tsx";
import { refLabel, refTone, timeAgo } from "./model.ts";

// The branch's commits, newest first, a page at a time as the list is scrolled, searched by message or
// author. The list starts over when its folder changes, and follows the folder as its history moves.

interface HistoryListProps {
  /** The work thread's folder, whose branch's commits are listed. */
  readonly root: string;
  /** Opens a commit: its full message and the files it changed. */
  readonly onOpen: (sha: string) => void;
}

/** One commit: its subject, the refs it carries, then who wrote it, when, and its short SHA. */
function CommitRow({ commit, now, onOpen }: { commit: Commit; now: number; onOpen: (sha: string) => void }) {
  const hidden = commit.refs.length - 3;
  return (
    <button
      type="button"
      onClick={() => onOpen(commit.sha)}
      className="flex w-full flex-col gap-1 border-b border-line-subtle px-3 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] text-fg-primary">{commit.subject}</span>
        {commit.unpushed === true ? (
          <span
            // A dot standing for a word, which `img` can't hold.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="img"
            aria-label="Not pushed yet"
            title="Not pushed yet"
            className="size-1.5 shrink-0 rounded-full bg-attention"
          />
        ) : null}
      </span>
      {commit.refs.length > 0 ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {commit.refs.slice(0, 3).map((ref) => (
            <span
              key={`${ref.kind}:${ref.name}`}
              className={`rounded border px-1.5 text-[11px] leading-4 ${refTone(ref)}`}
            >
              {refLabel(ref)}
            </span>
          ))}
          {hidden > 0 ? <span className="text-[11px] text-fg-tertiary">+{hidden}</span> : null}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-tertiary">
        <span className="truncate">{commit.author}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{timeAgo(commit.at, now)}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0 font-mono">{commit.short}</span>
      </span>
    </button>
  );
}

/** What the list has read so far: the page it is on, and each page by where it starts. */
interface Reading {
  readonly scope: string;
  readonly offset: number;
  readonly pages: Readonly<Record<number, CommitPage>>;
}

export function HistoryList({ root, onOpen }: HistoryListProps) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [now] = useState(Date.now);
  const sentinel = useRef<HTMLDivElement>(null);

  const version = useAtomValue(historyVersionAtom(root));
  // A new search, another folder or a moved history is another scope: the list starts over from its top.
  const scope = `${root}\n${query}\n${version}`;
  const [reading, setReading] = useState<Reading>();
  const current = reading?.scope === scope ? reading : undefined;
  const offset = current?.offset ?? 0;
  const pages = current?.pages ?? {};
  const result = useAtomValue(commitPageAtom(commitPageKey(root, query, offset)));
  const page = AsyncResult.isSuccess(result) ? result.value : undefined;

  // Searching waits a moment for the typing to stop.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), 200);
    return () => clearTimeout(timer);
  }, [typed]);

  // A page that arrives is kept where it starts, in the scope it was asked in. It's set while rendering,
  // as React allows for the component's own state, so the page shows in this same pass.
  if (page !== undefined && pages[offset] !== page) {
    setReading({ scope, offset, pages: { ...pages, [offset]: page } });
  }

  const starts = Object.keys(pages)
    .map(Number)
    .toSorted((a, b) => a - b);
  const commits = starts.flatMap((start) => pages[start]?.commits ?? []);
  const latestStart = starts.at(-1) ?? 0;
  const more = pages[latestStart]?.more === true;
  const repository = pages[0]?.repository;
  const loading = !AsyncResult.isFailure(result) && page === undefined;

  // Scrolling to the end asks for the next page, once the last one is in.
  useEffect(() => {
    const node = sentinel.current;
    if (node === null || !more || offset !== latestStart) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setReading((prior) => ({
          scope,
          offset: commits.length,
          pages: prior?.scope === scope ? prior.pages : {},
        }));
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, offset, latestStart, commits.length, scope]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <Search size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <input
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          placeholder="Search messages and authors"
          aria-label="Search commits"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary"
        />
        {typed === "" ? null : (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setTyped("")}
            className="grid size-5 shrink-0 place-items-center rounded text-fg-tertiary hover:text-fg-primary"
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {repository === false ? (
          <Note>This folder isn't in a git repository.</Note>
        ) : AsyncResult.isFailure(result) && commits.length === 0 ? (
          <Note>{messageOf(result.cause, "Git couldn't list the commits.")}</Note>
        ) : page !== undefined && commits.length === 0 ? (
          <Note>{query === "" ? "No commits yet." : "No commit matches that."}</Note>
        ) : (
          commits.map((commit) => <CommitRow key={commit.sha} commit={commit} now={now} onOpen={onOpen} />)
        )}
        <div ref={sentinel} className="h-px" />
        {loading ? <p className="px-3 py-2 text-[12px] text-fg-tertiary">Loading commits…</p> : null}
      </div>
    </div>
  );
}
