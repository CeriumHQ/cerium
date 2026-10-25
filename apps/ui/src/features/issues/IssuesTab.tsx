import type { GitHubRepository } from "@cerium/rpc";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { LoaderCircle, Plus } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { issueFiltersAtom, issuePageAtom, issuePageKey, refreshIssueList } from "../../backend/issues.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { SearchBar } from "../../components/ui/SearchBar.tsx";
import { messageOf } from "../viewer/previews.tsx";
import { IssueFilterMenu } from "./IssueFilterMenu.tsx";
import { IssueRow } from "./IssueRow.tsx";
import { NewIssueDialog } from "./NewIssueDialog.tsx";
import { canTriage, filtersKey, filtersOfKey, isFiltered } from "./model.ts";
import { useRefresh } from "../github/useRefresh.ts";

/** How long typing in the search waits before it asks GitHub. */
const TYPING_MS = 350;
/** The list reads again this often while it shows, and when the window returns after this long. */
const REFRESH_MS = 2 * 60_000;
const RETURN_MS = 30_000;

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-6 text-center text-body text-balance text-fg-tertiary max-md:text-[14px]">
    {children}
  </p>
);

/**
 * A page of the list and, once the user scrolls to its end, the page after it. Issues an earlier page
 * already showed are skipped, since a list read again after changes can repeat one at a page's edge.
 */
function Page({
  cwd,
  filters,
  after,
  seen,
  now,
  activeNumber,
  onOpen,
  onClear,
}: {
  cwd: string;
  filters: string;
  after: string | undefined;
  seen: ReadonlySet<number>;
  now: number;
  activeNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
  onClear: () => void;
}) {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(issuePageAtom(issuePageKey(cwd, filters, after)));
  const page = Option.getOrUndefined(AsyncResult.value(result));
  const [reading, setReading] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const next = page?.next;

  // The page after this one is read when its end comes into view.
  useEffect(() => {
    const element = end.current;
    if (element === null || next === undefined || reading) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setReading(true);
      },
      { rootMargin: "240px" },
    );
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [next, reading]);

  if (page === undefined) {
    if (AsyncResult.isFailure(result)) {
      return (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <p className="text-body text-balance text-fg-secondary max-md:text-[14px]">
            {messageOf(result.cause, "The issues couldn't be read.")}
          </p>
          <button
            type="button"
            onClick={() => refreshIssueList(registry, cwd)}
            className="rounded-md px-2 py-1 text-body text-fg-primary hover:bg-surface-hover"
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <output className="grid place-items-center py-8 text-fg-tertiary" aria-label="Reading issues">
        <LoaderCircle size={16} className="animate-spin" />
      </output>
    );
  }

  const rows = page.issues.filter((issue) => !seen.has(issue.number));
  const shown = new Set([...seen, ...rows.map((issue) => issue.number)]);
  if (after === undefined && page.issues.length === 0) {
    return isFiltered(filtersOfKey(filters)) ? (
      <Quiet>
        No issues match.{" "}
        <button type="button" onClick={onClear} className="text-fg-secondary underline underline-offset-2">
          Clear filters
        </button>
      </Quiet>
    ) : (
      <Quiet>No open issues.</Quiet>
    );
  }
  return (
    <>
      {rows.map((issue) => (
        <IssueRow
          key={issue.number}
          issue={issue}
          now={now}
          active={issue.number === activeNumber}
          onOpen={onOpen}
        />
      ))}
      {next === undefined ? null : reading ? (
        <Page
          cwd={cwd}
          filters={filters}
          after={next}
          seen={shown}
          now={now}
          activeNumber={activeNumber}
          onOpen={onOpen}
          onClear={onClear}
        />
      ) : (
        <div ref={end} className="h-8" aria-hidden />
      )}
    </>
  );
}

/**
 * The Issues tab: a search and filters over the repository's issues, newest activity first, with more
 * read as the list is scrolled. The list follows the repository while it shows.
 */
export function IssuesTab(props: {
  /** The work thread's folder, whose repository's issues are listed. */
  cwd: string;
  /** The repository the folder is in, as the GitHub panel has read it. */
  repository: GitHubRepository;
  /** The issue the viewer shows, marked in the list. */
  activeNumber: number | undefined;
  /** Shows an issue in the viewer: one picked from the list, or one just created. */
  onOpen: (number: number, title: string) => void;
}) {
  return props.repository.hasIssues ? (
    <IssueList {...props} />
  ) : (
    <Quiet>Issues are turned off for this repository.</Quiet>
  );
}

function IssueList({
  cwd,
  repository,
  activeNumber,
  onOpen,
}: {
  cwd: string;
  repository: GitHubRepository;
  activeNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const filters = useAtomValue(issueFiltersAtom(cwd));
  const [typed, setTyped] = useState(filters.search ?? "");
  const [now, setNow] = useState(Date.now);
  const [creating, setCreating] = useState(false);
  const key = filtersKey(filters);

  // What is typed reaches the filters a moment after the typing stops.
  useEffect(() => {
    if (typed.trim() === (filters.search?.trim() ?? "")) return;
    const timer = setTimeout(() => {
      registry.update(issueFiltersAtom(cwd), (each) => {
        const { search: _, ...rest } = each;
        return typed.trim() === "" ? rest : { ...rest, search: typed.trim() };
      });
    }, TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed, filters.search, cwd, registry]);

  useRefresh(
    () => {
      setNow(Date.now());
      refreshIssueList(registry, cwd);
    },
    REFRESH_MS,
    RETURN_MS,
  );

  const clear = () => {
    setTyped("");
    registry.set(issueFiltersAtom(cwd), {});
  };

  return (
    <div className="flex h-full flex-col">
      <SearchBar value={typed} onChange={setTyped} placeholder="Search issues">
        <IssueFilterMenu
          cwd={cwd}
          filters={filters}
          onChange={(next) => registry.set(issueFiltersAtom(cwd), next)}
        />
        <IconButton
          icon={Plus}
          label="New issue"
          onClick={() => setCreating(true)}
          className="max-md:size-10"
        />
      </SearchBar>
      <NewIssueDialog
        cwd={cwd}
        open={creating}
        onOpenChange={setCreating}
        onCreated={onOpen}
        mayLabel={canTriage(repository.permission)}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px px-1.5 py-1.5">
          <Page
            // The list starts over when the folder or the filters change.
            key={`${cwd}\n${key}`}
            cwd={cwd}
            filters={key}
            after={undefined}
            seen={new Set()}
            now={now}
            activeNumber={activeNumber}
            onOpen={onOpen}
            onClear={clear}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
