import { Button } from "@base-ui/react/button";
import type { ChecksState, GitHubRepository, PullRequestFilters, PullRequestSummary } from "@cerium/rpc";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { Check, CircleDashed, GitBranch, ListFilter, Plus, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { branchPullAtom, pullPageAtom, pullPageKey } from "../../backend/github.ts";
import {
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { barButtonClass, SearchBar, SetCount } from "../../components/ui/SearchBar.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../lib/time.ts";
import {
  checksLabel,
  failureMessage,
  NO_PULL_FILTERS,
  pullFilterCount,
  pullFiltersKey,
  pullStateOf,
} from "./model.ts";
import { CommentCount, ItemRow, loginOf, PullStateIcon } from "./parts.tsx";

/** The list's filters for each folder while the window is open, so closing the panel keeps them. */
const filtersAtom = Atom.family((_cwd: string) =>
  Atom.make<PullRequestFilters>(NO_PULL_FILTERS).pipe(Atom.keepAlive),
);

/** How long typing pauses before the list searches for it. */
const SEARCH_PAUSE_MS = 350;

/**
 * The Pull requests tab: the checked-out branch's pull request (or the way to open one), then the
 * repository's, most recently updated first, filtered and searched, reading on as the user scrolls.
 */
export function PullRequestList({
  cwd,
  repository,
  openNumber,
  onOpen,
  onCreate,
}: {
  cwd: string;
  repository: GitHubRepository;
  /** The pull request whose tab shows, picked out in the list. */
  openNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
  /** Opens a pull request from the checked-out branch. */
  onCreate: () => void;
}) {
  const [filters, setFilters] = useAtom(filtersAtom(cwd));
  const key = pullFiltersKey(filters);
  return (
    <div className="flex h-full flex-col">
      <FilterBar filters={filters} onChange={setFilters} />
      <ScrollArea className="min-h-0 flex-1">
        <BranchRow
          cwd={cwd}
          repository={repository}
          openNumber={openNumber}
          onOpen={onOpen}
          onCreate={onCreate}
        />
        {/* A new filter starts the list over from its first page. */}
        <Pages
          key={key}
          cwd={cwd}
          filters={key}
          filtered={pullFilterCount(filters) > 0 || (filters.search?.trim() ?? "") !== ""}
          onClear={() => setFilters(NO_PULL_FILTERS)}
          openNumber={openNumber}
          onOpen={onOpen}
        />
      </ScrollArea>
    </div>
  );
}

type StateFilter = NonNullable<PullRequestFilters["state"]>;
type FlagFilter = "createdByMe" | "reviewRequested" | "assignedToMe";

/**
 * The filters with one of their flags set or cleared. Out here because the React Compiler skips a
 * component that takes a computed key out of an object.
 */
const withFlag = (filters: PullRequestFilters, name: FlagFilter, on: boolean): PullRequestFilters => {
  const { [name]: _, ...rest } = filters;
  return on ? { ...rest, [name]: true } : rest;
};

/** The search field and the filter menu over the list. */
function FilterBar({
  filters,
  onChange,
}: {
  filters: PullRequestFilters;
  onChange: (filters: PullRequestFilters) => void;
}) {
  const [text, setText] = useState(filters.search ?? "");
  // Filters cleared from the list clear the field too.
  const [searched, setSearched] = useState(filters.search);
  if (searched !== filters.search) {
    setSearched(filters.search);
    if ((filters.search ?? "") !== text.trim()) setText(filters.search ?? "");
  }
  // The list searches once typing pauses, not on every key.
  const search = useEffectEvent((value: string) => {
    if (value.trim() === (filters.search?.trim() ?? "")) return;
    const { search: _, ...rest } = filters;
    onChange(value.trim() === "" ? rest : { ...rest, search: value.trim() });
  });
  useEffect(() => {
    const timer = setTimeout(() => search(text), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const count = pullFilterCount(filters);
  const set = (name: FlagFilter, on: boolean) => onChange(withFlag(filters, name, on));
  return (
    <SearchBar value={text} onChange={setText} placeholder="Search pull requests">
      <MenuRoot>
        <Tooltip label="Filter pull requests">
          <MenuTrigger>
            <Button
              aria-label={count > 0 ? `Filter pull requests, ${count} set` : "Filter pull requests"}
              className={`${barButtonClass} ${count > 0 ? "text-fg-primary" : "text-fg-tertiary"}`}
            >
              <ListFilter size={15} strokeWidth={1.75} />
              <SetCount count={count} />
            </Button>
          </MenuTrigger>
        </Tooltip>
        <MenuPopup>
          <MenuRadioGroup
            value={filters.state ?? "open"}
            onValueChange={(value: StateFilter) => {
              const { state: _, ...rest } = filters;
              onChange(value === "open" ? rest : { ...rest, state: value });
            }}
          >
            <MenuGroupLabel>Show</MenuGroupLabel>
            <MenuRadioItem value="open">Open</MenuRadioItem>
            <MenuRadioItem value="closed">Closed</MenuRadioItem>
            <MenuRadioItem value="merged">Merged</MenuRadioItem>
            <MenuRadioItem value="all">All</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={filters.createdByMe === true}
            onCheckedChange={(on) => set("createdByMe", on)}
          >
            Opened by me
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={filters.reviewRequested === true}
            onCheckedChange={(on) => set("reviewRequested", on)}
          >
            Waiting on my review
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={filters.assignedToMe === true}
            onCheckedChange={(on) => set("assignedToMe", on)}
          >
            Assigned to me
          </MenuCheckboxItem>
        </MenuPopup>
      </MenuRoot>
    </SearchBar>
  );
}

/**
 * The checked-out branch's own pull request, kept at the top; or, on a branch of its own with none,
 * the way to open one.
 */
function BranchRow({
  cwd,
  repository,
  openNumber,
  onOpen,
  onCreate,
}: {
  cwd: string;
  repository: GitHubRepository;
  openNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
  onCreate: () => void;
}) {
  const result = useAtomValue(branchPullAtom(cwd));
  const branch = AsyncResult.isSuccess(result) ? result.value : undefined;
  if (branch?.branch === undefined) return null;
  const pull = branch.pullRequest;
  const heading = (
    <h3 className="flex h-7 items-center gap-1.5 px-2 text-caption font-medium text-fg-tertiary max-md:h-9 max-md:text-[13px]">
      <GitBranch size={12} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{branch.branch}</span>
    </h3>
  );
  if (pull !== undefined && pull.state === "open") {
    return (
      <section aria-label="This branch" className="border-b border-line-subtle px-1.5 pt-1 pb-1.5">
        {heading}
        <PullRow pull={pull} selected={openNumber === pull.number} onOpen={onOpen} />
      </section>
    );
  }
  if (branch.branch === repository.defaultBranch) return null;
  return (
    <section aria-label="This branch" className="border-b border-line-subtle px-1.5 pt-1 pb-2">
      {heading}
      <Button
        onClick={onCreate}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-11 max-md:text-[14px]"
      >
        <Plus size={14} strokeWidth={1.75} className="shrink-0" />
        Open a pull request from this branch
      </Button>
    </section>
  );
}

/** The list's pages: the first, then each one scrolling to the end asks for. */
function Pages({
  cwd,
  filters,
  filtered,
  onClear,
  openNumber,
  onOpen,
}: {
  cwd: string;
  /** The filters' key. */
  filters: string;
  filtered: boolean;
  onClear: () => void;
  openNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
}) {
  const [after, setAfter] = useState<ReadonlyArray<string>>([]);
  const more = (next: string) =>
    setAfter((current) => (current.includes(next) ? current : [...current, next]));
  const pages = [undefined, ...after];
  return (
    <ul className="flex flex-col gap-px px-1.5 py-1.5" aria-label="Pull requests">
      {pages.map((cursor, index) => (
        <Page
          key={cursor ?? ""}
          cwd={cwd}
          filters={filters}
          after={cursor}
          last={index === pages.length - 1}
          onMore={more}
          filtered={filtered}
          onClear={onClear}
          openNumber={openNumber}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function Page({
  cwd,
  filters,
  after,
  last,
  onMore,
  filtered,
  onClear,
  openNumber,
  onOpen,
}: {
  cwd: string;
  filters: string;
  after: string | undefined;
  last: boolean;
  onMore: (next: string) => void;
  filtered: boolean;
  onClear: () => void;
  openNumber: number | undefined;
  onOpen: (number: number, title: string) => void;
}) {
  const result = useAtomValue(pullPageAtom(pullPageKey(cwd, filters, after)));
  const page = AsyncResult.getOrElse(result, () => undefined);
  if (page === undefined) {
    if (AsyncResult.isFailure(result)) {
      return (
        <li className="px-4 py-6 text-center text-meta text-error-text">
          {failureMessage(result.cause, "The pull requests couldn't be listed.")}
        </li>
      );
    }
    return after === undefined ? <Skeleton /> : <li className="h-14" />;
  }
  if (after === undefined && page.pullRequests.length === 0) {
    return (
      <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-meta text-fg-tertiary">
        {filtered ? "No pull requests match." : "No open pull requests."}
        {filtered ? (
          <Button
            onClick={onClear}
            className="rounded-md px-2 py-1 text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
          >
            Clear filters
          </Button>
        ) : null}
      </li>
    );
  }
  return (
    <>
      {page.pullRequests.map((pull) => (
        <li key={pull.number}>
          <PullRow pull={pull} selected={openNumber === pull.number} onOpen={onOpen} />
        </li>
      ))}
      {last && page.next !== undefined ? <ReadOn next={page.next} onMore={onMore} /> : null}
    </>
  );
}

/** Asks for the next page once the end of the list scrolls into view. */
function ReadOn({ next, onMore }: { next: string; onMore: (next: string) => void }) {
  const element = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore(next);
      },
      { rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [next, onMore]);
  return (
    <li ref={element} className="flex h-12 items-center justify-center text-meta text-fg-tertiary">
      Loading more…
    </li>
  );
}

function Skeleton() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((index) => (
        <li key={index} className="flex gap-2.5 px-2 py-2.5" aria-hidden="true">
          <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded-full bg-surface-hover" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-4/5 animate-pulse rounded bg-surface-hover" />
            <span className="h-3 w-2/5 animate-pulse rounded bg-surface-hover" />
          </span>
        </li>
      ))}
    </>
  );
}

const reviewLook = {
  approved: { label: "Approved", tone: "text-success-text" },
  changesRequested: { label: "Changes requested", tone: "text-error-text" },
  reviewRequired: undefined,
} as const;

/** A pull request in the list: its state, title, number, author, and how its checks and reviews stand. */
function PullRow({
  pull,
  selected,
  onOpen,
}: {
  pull: PullRequestSummary;
  selected: boolean;
  onOpen: (number: number, title: string) => void;
}) {
  const review = pull.reviewDecision === undefined ? undefined : reviewLook[pull.reviewDecision];
  return (
    <ItemRow
      icon={<PullStateIcon state={pullStateOf(pull)} size={15} />}
      title={pull.title}
      facts={
        <>
          <span className="shrink-0 tabular-nums">#{pull.number}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{loginOf(pull.author)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{shortAgo(pull.updatedAt)}</span>
        </>
      }
      marks={
        <>
          {pull.mergeable === "conflicting" && pull.state === "open" ? (
            <span className="text-attention-text">Conflicts</span>
          ) : null}
          {review === undefined ? null : <span className={review.tone}>{review.label}</span>}
          <CommentCount count={pull.comments} />
          {pull.checks === undefined ? null : <ChecksMark state={pull.checks} />}
        </>
      }
      labels={pull.labels}
      current={selected}
      onOpen={() => onOpen(pull.number, pull.title)}
    />
  );
}

/** How a pull request's checks stand, as a mark in its row. */
export function ChecksMark({ state, size = 12 }: { state: ChecksState; size?: number }) {
  return (
    <span aria-label={checksLabel[state]} className="flex">
      {state === "passing" ? (
        <Check size={size} strokeWidth={2.5} className="text-success-text" />
      ) : state === "failing" ? (
        <X size={size} strokeWidth={2.5} className="text-error-text" />
      ) : (
        <CircleDashed size={size} strokeWidth={2.25} className="text-attention-text" />
      )}
    </span>
  );
}
