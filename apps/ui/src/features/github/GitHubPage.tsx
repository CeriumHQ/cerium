import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { ExternalLink, GitPullRequest, ListFilter, RefreshCw } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";

import { githubStatusAtom } from "../../backend/github.ts";
import { githubFeedAtom, githubFeedKey, refreshGitHubFeed } from "../../backend/githubFeed.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { barButtonClass, SearchBar, SetCount } from "../../components/ui/SearchBar.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../lib/time.ts";
import { useMinute } from "../../lib/useMinute.ts";
import { StateIcon } from "../issues/parts.tsx";
import {
  feedKey,
  feedScopes,
  matchesQuery,
  parseGitHubLink,
  type FeedItem,
  type FeedKind,
  type FeedScope,
} from "./feed.ts";
import { GitHubSignIn } from "./GitHubSignIn.tsx";
import { pullStateOf, type GitHubTab } from "./model.ts";
import { CommentCount, ItemRow, PullStateIcon } from "./parts.tsx";
import { ChecksMark } from "./PullRequestList.tsx";

/** What the page lists, kept while the window is open. */
const scopeAtom = Atom.make<FeedScope>("open").pipe(Atom.keepAlive);
const kindAtom = Atom.make<FeedKind>("all").pipe(Atom.keepAlive);

const kindClass =
  "flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-primary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:h-9 max-md:px-2.5 max-md:text-sm";

/**
 * The rail's GitHub page, in the sidebar's place: the open pull requests and issues of every project's
 * repository, newest activity first. Search finds them by title, repository or number, and a pasted
 * link to one opens it.
 */
export function GitHubPageList({
  selected,
  onOpen,
  issues,
}: {
  /** The key (`githubKey`) of the item the page shows. */
  selected: string | undefined;
  onOpen: (tab: GitHubTab, title?: string) => void;
  /** The machine has the issue calls. */
  issues: boolean;
}) {
  const registry = useContext(RegistryContext);
  const [scope, setScope] = useAtom(scopeAtom);
  const [kind, setKind] = useAtom(kindAtom);
  const [query, setQuery] = useState("");
  const status = AsyncResult.getOrElse(useAtomValue(githubStatusAtom), () => undefined);
  const feed = useAtomValue(githubFeedAtom(githubFeedKey(scope, issues)));
  const refresh = () => {
    registry.refresh(githubStatusAtom);
    refreshGitHubFeed(registry);
  };

  const link = parseGitHubLink(query);
  const linkRoot = link === undefined ? undefined : feed.roots.get(link.repo.toLowerCase());
  const found = feed.items.filter((item) => link !== undefined || matchesQuery(item, query));
  const pulls = found.filter((item) => item.kind === "pr");
  const issueItems = found.filter((item) => item.kind === "issue");
  const shown = kind === "pr" ? pulls : kind === "issue" ? issueItems : found;
  const now = useMinute();

  const gate =
    status?._tag === "GhMissing" ? (
      <Notice
        title="GitHub CLI isn't installed"
        body="Pull requests and issues go through GitHub's own CLI, gh."
      >
        <a
          href={status.installUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90"
        >
          <ExternalLink size={13} strokeWidth={2} />
          Get GitHub CLI
        </a>
      </Notice>
    ) : status?._tag === "GhInstalled" && status.accounts.length === 0 ? (
      <Notice title="Sign in to GitHub" body="The GitHub CLI keeps the sign-in; Cerium never sees it.">
        <GitHubSignIn onSignedIn={refresh} />
      </Notice>
    ) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-2 pl-3.5">
        <h2 className="text-reading font-semibold text-fg-primary max-md:text-base">GitHub</h2>
        <span className="ml-auto" />
        <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} className="max-md:size-10" />
      </div>
      {gate ?? (
        <>
          <div className="mx-2 mb-2.5 overflow-hidden rounded-lg border border-line-subtle bg-surface-sunken [&>div]:h-8 [&>div]:border-b-0 [&>div]:pl-2.5">
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Search or paste a link"
              label="Search pull requests and issues, or paste a link to one"
            >
              <MenuRoot>
                <Tooltip label="Whose">
                  <MenuTrigger>
                    <Button
                      aria-label={`Show: ${feedScopes.find((each) => each.scope === scope)?.label ?? ""}`}
                      className={`${barButtonClass} size-6.5! ${scope === "open" ? "text-fg-tertiary" : "text-fg-primary"}`}
                    >
                      <ListFilter size={14} strokeWidth={1.75} />
                      <SetCount count={scope === "open" ? 0 : 1} />
                    </Button>
                  </MenuTrigger>
                </Tooltip>
                <MenuPopup align="end">
                  <MenuRadioGroup value={scope} onValueChange={(value: FeedScope) => setScope(value)}>
                    <MenuGroupLabel>Show</MenuGroupLabel>
                    {feedScopes.map(({ scope: each, label }) => (
                      <MenuRadioItem key={each} value={each}>
                        {label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </MenuRoot>
            </SearchBar>
          </div>
          {link === undefined ? (
            <ToggleGroup
              value={[kind]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "all" || next === "pr" || next === "issue") setKind(next);
              }}
              aria-label="Show"
              className="flex items-center px-2 pb-2"
            >
              <Toggle value="all" className={kindClass}>
                All <Count count={found.length} />
              </Toggle>
              <Toggle value="pr" className={kindClass}>
                Pull requests <Count count={pulls.length} />
              </Toggle>
              {issues ? (
                <Toggle value="issue" className={kindClass}>
                  Issues <Count count={issueItems.length} />
                </Toggle>
              ) : null}
            </ToggleGroup>
          ) : null}
          <ScrollArea className="flex-1">
            {link !== undefined ? (
              <div className="px-2">
                {linkRoot === undefined ? (
                  <p className="px-2 py-3 text-meta text-fg-tertiary">
                    {link.repo} isn't one of your projects' repositories.
                  </p>
                ) : (
                  <ItemRow
                    icon={<GitPullRequest size={15} strokeWidth={1.75} className="text-fg-secondary" />}
                    title={`Open ${link.kind === "pr" ? "pull request" : "issue"} #${link.number}`}
                    facts={<span className="truncate">{link.repo}</span>}
                    labels={[]}
                    current={false}
                    onOpen={() => {
                      onOpen({ root: linkRoot, kind: link.kind, number: link.number });
                      setQuery("");
                    }}
                  />
                )}
              </div>
            ) : shown.length > 0 ? (
              <ul className="flex flex-col gap-px px-2 pb-3">
                {shown.map((item) => (
                  <li key={feedKey(item)}>
                    <FeedRow item={item} now={now} selected={feedKey(item) === selected} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            ) : feed.loading ? (
              <Skeleton />
            ) : (
              <p className="px-4 py-6 text-center text-meta leading-relaxed text-pretty text-fg-tertiary">
                {feed.roots.size === 0
                  ? "Projects whose folder is a GitHub repository show their pull requests and issues here."
                  : query.trim() !== ""
                    ? "Nothing matches."
                    : "Nothing here."}
              </p>
            )}
          </ScrollArea>
        </>
      )}
    </div>
  );
}

function Count({ count }: { count: number }) {
  return <span className="font-normal text-fg-tertiary tabular-nums">{count}</span>;
}

const reviewLook = {
  approved: { label: "Approved", tone: "text-success" },
  changesRequested: { label: "Changes requested", tone: "text-error" },
  reviewRequired: undefined,
} as const;

/** A pull request or an issue in the page's list, under the repository it's in. */
function FeedRow({
  item,
  now,
  selected,
  onOpen,
}: {
  item: FeedItem;
  now: number;
  selected: boolean;
  onOpen: (tab: GitHubTab, title?: string) => void;
}) {
  const [repoOwner, repoName] = item.repo.split("/");
  const facts = (number: number, updatedAt: number) => (
    <>
      <span className="min-w-0 truncate" title={item.repo}>
        {repoName ?? repoOwner}
      </span>
      <span className="shrink-0 tabular-nums">#{number}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0 tabular-nums">{shortAgo(updatedAt, now)}</span>
    </>
  );
  if (item.kind === "pr") {
    const { pull } = item;
    const review = pull.reviewDecision === undefined ? undefined : reviewLook[pull.reviewDecision];
    return (
      <ItemRow
        icon={<PullStateIcon state={pullStateOf(pull)} size={15} />}
        title={pull.title}
        facts={facts(pull.number, pull.updatedAt)}
        marks={
          <>
            {review === undefined ? null : <span className={review.tone}>{review.label}</span>}
            <CommentCount count={pull.comments} />
            {pull.checks === undefined ? null : <ChecksMark state={pull.checks} />}
          </>
        }
        labels={[]}
        current={selected}
        onOpen={() => onOpen({ root: item.root, kind: "pr", number: pull.number }, pull.title)}
      />
    );
  }
  const { issue } = item;
  return (
    <ItemRow
      icon={<StateIcon issue={issue} size={15} />}
      title={issue.title}
      facts={facts(issue.number, issue.updatedAt)}
      marks={<CommentCount count={issue.comments} />}
      labels={[]}
      current={selected}
      onOpen={() => onOpen({ root: item.root, kind: "issue", number: issue.number }, issue.title)}
    />
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-1 px-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex gap-2.5 px-2 py-2">
          <span className="size-[15px] shrink-0 animate-pulse rounded-full bg-surface-hover" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3 w-4/5 animate-pulse rounded bg-surface-hover" />
            <span className="h-2.5 w-2/5 animate-pulse rounded bg-surface-hover" />
          </span>
        </div>
      ))}
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-reading font-medium text-fg-primary">{title}</h3>
        <p className="text-meta leading-relaxed text-pretty text-fg-secondary">{body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** The page's main area while nothing is picked. */
export function GitHubPageEmpty() {
  return (
    <div className="grid h-full place-items-center rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
      <div className="flex flex-col items-center gap-2 text-fg-tertiary">
        <GitPullRequest size={22} strokeWidth={1.5} />
        <p className="text-body">Pick a pull request or an issue</p>
      </div>
    </div>
  );
}
