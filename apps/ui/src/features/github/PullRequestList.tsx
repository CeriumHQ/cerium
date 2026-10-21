import { Button } from "@base-ui/react/button";
import type { ChecksState, GitHubRepository, PullRequestFilters, PullRequestSummary } from "@cerium/rpc";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { Check, CircleDashed, GitBranch, ListFilter, MessageSquare, Plus, Search, X } from "lucide-react";
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
import { LabelChip, loginOf, PullStateIcon } from "./parts.tsx";

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
  const set = (name: "createdByMe" | "reviewRequested" | "assignedToMe", on: boolean) => {
    const { [name]: _, ...rest } = filters;
    onChange(on ? { ...rest, [name]: true } : rest);
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-2">
      <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-window px-2.5 text-fg-tertiary focus-within:border-line-strong max-md:h-10">
        <Search size={13} strokeWidth={1.75} className="shrink-0" />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text !== "") {
              event.preventDefault();
              setText("");
            }
          }}
          placeholder="Search pull requests"
          aria-label="Search pull requests"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
        />
        {text === "" ? null : (
          <Button
            aria-label="Clear the search"
            onClick={() => setText("")}
            className="grid size-5 shrink-0 place-items-center rounded text-fg-tertiary hover:text-fg-primary"
          >
            <X size={12} strokeWidth={2} />
          </Button>
        )}
      </label>
      <MenuRoot>
        <Tooltip label="Filter">
          <MenuTrigger>
            <Button
              aria-label={count > 0 ? `Filter, ${count} on` : "Filter"}
              className={`relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-surface-hover data-popup-open:bg-surface-hover max-md:size-10 ${count > 0 ? "text-fg-primary" : "text-fg-tertiary hover:text-fg-secondary"}`}
            >
              <ListFilter size={15} strokeWidth={1.75} />
              {count > 0 ? (
                <span className="absolute top-0.5 right-0.5 grid size-3.5 place-items-center rounded-full bg-accent text-[9px] font-semibold text-accent-fg tabular-nums">
                  {count}
                </span>
              ) : null}
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
    </div>
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
  if (pull !== undefined && pull.state === "open") {
    return (
      <section className="border-b border-line-subtle pb-1">
        <h3 className="flex items-center gap-1.5 px-3 pt-2.5 text-[11.5px] font-medium text-fg-tertiary">
          <GitBranch size={12} strokeWidth={2} />
          <span className="truncate font-mono">{branch.branch}</span>
        </h3>
        <PullRow pull={pull} selected={openNumber === pull.number} onOpen={onOpen} />
      </section>
    );
  }
  if (branch.branch === repository.defaultBranch) return null;
  return (
    <section className="flex items-center gap-2 border-b border-line-subtle px-3 py-2.5">
      <GitBranch size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-secondary" title={branch.branch}>
        {branch.branch}
      </span>
      <Button
        onClick={onCreate}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2 text-[12px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-9"
      >
        <Plus size={13} strokeWidth={2} />
        Open a pull request
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
    <ul className="flex flex-col py-1" aria-label="Pull requests">
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
        <li className="px-4 py-6 text-center text-[12.5px] text-error">
          {failureMessage(result.cause, "The pull requests couldn't be listed.")}
        </li>
      );
    }
    return after === undefined ? <Skeleton /> : <li className="h-14" />;
  }
  if (after === undefined && page.pullRequests.length === 0) {
    return (
      <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-[12.5px] text-fg-tertiary">
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
    <li ref={element} className="flex h-12 items-center justify-center text-[12px] text-fg-tertiary">
      Loading more…
    </li>
  );
}

function Skeleton() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((index) => (
        <li key={index} className="flex gap-2.5 px-3 py-2.5" aria-hidden="true">
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
  approved: { label: "Approved", tone: "text-success" },
  changesRequested: { label: "Changes requested", tone: "text-error" },
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
    <Button
      onClick={() => onOpen(pull.number, pull.title)}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full gap-2.5 px-3 py-2 text-left transition-colors max-md:py-3 ${selected ? "bg-surface-selected" : "hover:bg-surface-hover"}`}
    >
      <span className="pt-[3px]">
        <PullStateIcon state={pullStateOf(pull)} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-[13px] leading-[1.35] font-medium text-fg-primary max-md:text-[15px]">
          {pull.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-tertiary max-md:text-[13px]">
          <span className="shrink-0 tabular-nums">#{pull.number}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{loginOf(pull.author)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{shortAgo(pull.updatedAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {pull.mergeable === "conflicting" && pull.state === "open" ? (
              <span className="text-attention">Conflicts</span>
            ) : null}
            {review === undefined ? null : <span className={review.tone}>{review.label}</span>}
            {pull.comments > 0 ? (
              <span
                className="flex items-center gap-0.5 tabular-nums"
                aria-label={`${pull.comments} comments`}
              >
                <MessageSquare size={11} strokeWidth={2} />
                {pull.comments}
              </span>
            ) : null}
            {pull.checks === undefined ? null : <ChecksMark state={pull.checks} />}
          </span>
        </span>
        {pull.labels.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap gap-1 pt-0.5">
            {pull.labels.slice(0, 4).map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </span>
        )}
      </span>
    </Button>
  );
}

/** How a pull request's checks stand, as a mark in its row. */
export function ChecksMark({ state, size = 12 }: { state: ChecksState; size?: number }) {
  return (
    <span aria-label={checksLabel[state]} className="flex">
      {state === "passing" ? (
        <Check size={size} strokeWidth={2.5} className="text-success" />
      ) : state === "failing" ? (
        <X size={size} strokeWidth={2.5} className="text-error" />
      ) : (
        <CircleDashed size={size} strokeWidth={2.25} className="text-attention" />
      )}
    </span>
  );
}
