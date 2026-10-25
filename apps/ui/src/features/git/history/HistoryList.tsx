import type { Commit, CommitPage } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { commitPageAtom, commitPageKey, historyVersionAtom } from "../../../backend/history.ts";
import { SearchBar } from "../../../components/ui/SearchBar.tsx";
import { Note, messageOf } from "../../viewer/previews.tsx";
import { timeAgo } from "./model.ts";
import { RefChip } from "./RefChip.tsx";

// The branch's commits, newest first, a page at a time as the list is scrolled, searched by message or
// author. The list starts over when its folder changes, and follows the folder as its history moves.

interface HistoryListProps {
  /** The work thread's folder, whose branch's commits are listed. */
  readonly root: string;
  /** Opens a commit: its full message and the files it changed. */
  readonly onOpen: (sha: string) => void;
}

/** Refs a row shows before it counts the rest. */
const REFS_SHOWN = 1;

/**
 * One commit: its subject, then its short SHA, who wrote it and when, whether it's pushed yet, and at
 * the end of that line the refs it carries.
 */
function CommitRow({ commit, now, onOpen }: { commit: Commit; now: number; onOpen: (sha: string) => void }) {
  const hidden = commit.refs.length - REFS_SHOWN;
  return (
    <button
      type="button"
      onClick={() => onOpen(commit.sha)}
      className="flex w-full shrink-0 flex-col gap-0.5 rounded-lg px-2 py-2 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:py-3"
    >
      <span className="truncate text-body leading-[18px] text-fg-primary max-md:text-[15px] max-md:leading-5">
        {commit.subject}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-meta leading-4 text-fg-tertiary max-md:text-[13px]">
        <span className="shrink-0 font-mono text-meta">{commit.short}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{commit.author}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0 tabular-nums">{timeAgo(commit.at, now)}</span>
        {commit.unpushed === true ? (
          <span title="Not pushed yet" className="flex shrink-0 items-center text-fg-secondary">
            <ArrowUp size={12} strokeWidth={2} aria-label="Not pushed yet" />
          </span>
        ) : null}
        {commit.refs.length === 0 ? null : (
          <span className="ml-auto flex max-w-[55%] min-w-0 shrink-0 items-center justify-end gap-1 pl-1">
            {commit.refs.slice(0, REFS_SHOWN).map((ref) => (
              <RefChip key={`${ref.kind}:${ref.name}`} marker={ref} />
            ))}
            {hidden > 0 ? (
              <span
                className="shrink-0 text-caption tabular-nums"
                title={commit.refs.map((ref) => ref.name).join(", ")}
              >
                +{hidden}
              </span>
            ) : null}
          </span>
        )}
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
      <SearchBar
        value={typed}
        onChange={setTyped}
        placeholder="Search messages and authors"
        label="Search commits"
      />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 py-1.5">
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
        {loading ? <p className="px-3 py-2 text-meta text-fg-tertiary">Loading commits…</p> : null}
      </div>
    </div>
  );
}
