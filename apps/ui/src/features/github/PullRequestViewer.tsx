import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { GitHubRepository, PullRequestDetail, Reviewer, ReviewThread } from "@cerium/rpc";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Columns2,
  ExternalLink,
  GitBranch,
  GitPullRequestDraft,
  Link,
  MessageSquare,
  Rows2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  githubRepositoryAtom,
  pullAtom,
  pullKey,
  pullTimelineAtom,
  pullTimelineKey,
} from "../../backend/github.ts";
import { DialogButton, FormDialog } from "../../components/ui/FormDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { useShortcut } from "../../lib/shortcuts.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { remember } from "../../lib/storage.ts";
import type { PaneChrome } from "../split/SplitView.tsx";
import { DIFF_LAYOUT_KEY, diffLayoutAtom } from "../viewer/model.ts";
import { Note } from "../viewer/previews.tsx";
import { Conversation } from "./Conversation.tsx";
import { failureMessage, pullRequestBrief, pullStateOf, threadsByReview } from "./model.ts";
import {
  CodeName,
  Fact,
  Facts,
  LabelChip,
  loginOf,
  MoreMenu,
  PersonChip,
  PullStateBadge,
  PullStateIcon,
  StartThreadButton,
  ViewerTitle,
  When,
} from "./parts.tsx";
import { MergeBox, PullComposer } from "./PullActionsBox.tsx";
import { PullChecks, PullCommits, PullFiles } from "./PullTabs.tsx";
import { ReviewThreadCard } from "./ReviewThreadCard.tsx";
import { usePullActions, usePullFreshness, type PullActions } from "./usePullRequest.ts";

type PullTab = "conversation" | "commits" | "checks" | "files";

/** The tab each pull request shows, by its key, while the window is open. */
const pullTabAtom = Atom.family((_id: string) => Atom.make<PullTab>("conversation").pipe(Atom.keepAlive));

const toggleClass =
  "shrink-0 rounded-md px-2 py-0.5 text-meta font-medium whitespace-nowrap text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[14px]";

const iconToggleClass =
  "grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:size-10";

/** How a thread that looks into a pull request starts. */
export interface PullThreadStart {
  readonly text: string;
  /** In a worktree of its own, where it checks the pull request out. */
  readonly worktree: boolean;
}

/**
 * A pull request in a tab of its own, kept current while it shows: its conversation with reviews and
 * their threads, its commits, its checks and the files it changes, with what the user may do to it.
 */
export function PullRequestViewer({
  cwd,
  number,
  worktrees,
  onStartThread,
  onClose,
  pane,
}: {
  /** The work thread's folder the panel acted on. */
  cwd: string;
  number: number;
  /** A thread can start in a worktree of its own. */
  worktrees: boolean;
  onStartThread: ((start: PullThreadStart) => void) | undefined;
  onClose: () => void;
  /** While it shares the main area with other panes, its header is the pane's. */
  pane?: PaneChrome | undefined;
}) {
  const id = pullKey(cwd, number);
  const result = useAtomValue(pullAtom(id));
  const pull = AsyncResult.getOrElse(result, () => undefined);
  const repository = AsyncResult.getOrElse(useAtomValue(githubRepositoryAtom(cwd)), () => undefined);
  const [tab, setTab] = useAtom(pullTabAtom(id));
  const [layout, setLayout] = useAtom(diffLayoutAtom);
  const actions = usePullActions(cwd, number);
  usePullFreshness(cwd, number, pull?.revision, pull?.checks === "pending");

  const header = (
    <Header
      number={number}
      pull={pull}
      tab={tab}
      onTab={setTab}
      layout={layout}
      onLayout={(next) => {
        setLayout(next);
        remember(DIFF_LAYOUT_KEY, next);
      }}
      worktrees={worktrees}
      onStartThread={onStartThread}
      actions={actions}
      onClose={onClose}
      pane={pane}
    />
  );

  return (
    <section aria-label={pull ? `#${number} ${pull.title}` : `#${number}`} className="flex h-full flex-col">
      {pane ? <ContextMenuArea menu={pane.menu}>{header}</ContextMenuArea> : header}
      <div className="min-h-0 flex-1">
        {pull === undefined ? (
          AsyncResult.isFailure(result) ? (
            <Note>{failureMessage(result.cause, "The pull request couldn't be read.")}</Note>
          ) : (
            <Note>Reading the pull request…</Note>
          )
        ) : (
          <ScrollArea className="h-full">
            <div
              className={`mx-auto flex flex-col gap-5 px-6 pt-5 pb-12 max-md:px-3 ${tab === "files" ? "max-w-[90rem]" : "max-w-[56rem]"}`}
            >
              <TitleBlock pull={pull} />
              {tab === "conversation" ? (
                <PullConversation
                  cwd={cwd}
                  id={id}
                  pull={pull}
                  repository={repository}
                  actions={actions}
                  onShowChecks={() => setTab("checks")}
                />
              ) : tab === "commits" ? (
                <PullCommits cwd={cwd} pull={pull} />
              ) : tab === "checks" ? (
                <PullChecks cwd={cwd} pull={pull} />
              ) : (
                <PullFiles cwd={cwd} pull={pull} layout={layout} actions={actions} />
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </section>
  );
}

function Header({
  number,
  pull,
  tab,
  onTab,
  layout,
  onLayout,
  worktrees,
  onStartThread,
  actions,
  onClose,
  pane,
}: {
  number: number;
  pull: PullRequestDetail | undefined;
  tab: PullTab;
  onTab: (tab: PullTab) => void;
  layout: "unified" | "split";
  onLayout: (layout: "unified" | "split") => void;
  worktrees: boolean;
  onStartThread: ((start: PullThreadStart) => void) | undefined;
  actions: PullActions;
  onClose: () => void;
  pane: PaneChrome | undefined;
}) {
  const [checkingOut, setCheckingOut] = useState(false);
  const start = (worktree: boolean) => {
    if (pull && onStartThread) onStartThread({ text: pullRequestBrief(pull, { worktree }), worktree });
  };
  const tabs: ReadonlyArray<{ value: PullTab; label: string; count?: number | undefined }> = [
    { value: "conversation", label: "Conversation" },
    { value: "commits", label: "Commits", count: pull?.commitCount },
    { value: "checks", label: "Checks" },
    { value: "files", label: "Files", count: pull?.changedFiles },
  ];
  return (
    <header
      {...pane?.grip}
      // A phone keeps the title and the buttons on one line, over a line of its own for the tabs, which
      // scroll when they don't fit: a tab cut off at the edge shows there's more.
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-auto max-md:flex-wrap max-md:gap-x-1 max-md:gap-y-0 max-md:pt-1 ${pane ? "select-none" : ""}`}
    >
      {pull ? <PullStateIcon state={pullStateOf(pull)} size={15} /> : null}
      <span className="flex min-w-0 items-baseline gap-1.5 text-body max-md:ml-1 max-md:flex-1 max-md:text-[15px]">
        <span className="shrink-0 text-fg-tertiary tabular-nums">#{number}</span>
        <span className="min-w-0 truncate font-medium text-fg-primary">{pull?.title ?? ""}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1 max-md:contents">
        {tab === "files" ? (
          <ToggleGroup
            value={[layout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "unified" || next === "split") onLayout(next);
            }}
            aria-label="Diff layout"
            className="mr-1 flex items-center max-md:hidden"
          >
            <Tooltip label="One column">
              <Toggle value="unified" aria-label="One column" className={iconToggleClass}>
                <Rows2 size={15} strokeWidth={1.75} />
              </Toggle>
            </Tooltip>
            <Tooltip label="Side by side">
              <Toggle value="split" aria-label="Side by side" className={iconToggleClass}>
                <Columns2 size={15} strokeWidth={1.75} />
              </Toggle>
            </Tooltip>
          </ToggleGroup>
        ) : null}
        <ToggleGroup
          value={[tab]}
          onValueChange={(value) => {
            const next = tabs.find((each) => each.value === value[0]);
            if (next) onTab(next.value);
          }}
          aria-label="Show"
          className="flex items-center max-md:order-last max-md:w-full max-md:overflow-x-auto max-md:py-1 max-md:[scrollbar-width:none]"
        >
          {tabs.map((each) => (
            <Toggle key={each.value} value={each.value} className={toggleClass}>
              {each.label}
              {each.count === undefined || each.count === 0 ? null : (
                <span className="ml-1 text-fg-tertiary tabular-nums">
                  <span className="sr-only"> </span>
                  {each.count}
                </span>
              )}
            </Toggle>
          ))}
        </ToggleGroup>
        {onStartThread ? (
          <span className="ml-1 max-md:ml-0 max-md:shrink-0">
            <StartThreadButton worktrees={worktrees} disabled={pull === undefined} onStart={start} />
          </span>
        ) : null}
        <MoreMenu>
          {pull ? (
            <>
              <MenuItem
                icon={ExternalLink}
                onClick={() => window.open(pull.url, "_blank", "noopener,noreferrer")}
              >
                Open on GitHub
              </MenuItem>
              <MenuItem icon={Link} onClick={() => void navigator.clipboard.writeText(pull.url)}>
                Copy link
              </MenuItem>
              {pull.state === "open" ? (
                <MenuItem icon={GitBranch} onClick={() => setCheckingOut(true)}>
                  Check out here
                </MenuItem>
              ) : null}
              {pull.state === "open" && pull.canUpdate ? (
                <MenuItem icon={GitPullRequestDraft} onClick={() => void actions.setDraft(!pull.draft)}>
                  {pull.draft ? "Ready for review" : "Convert to draft"}
                </MenuItem>
              ) : null}
            </>
          ) : null}
          {pane ? (
            <>
              {pull ? <MenuSeparator /> : null}
              {pane.menu}
            </>
          ) : null}
        </MoreMenu>
        <IconButton
          icon={X}
          label="Close"
          shortcut={useShortcut("close-tab")}
          onClick={onClose}
          className="max-md:size-10 max-md:shrink-0"
        />
      </div>
      {pull ? (
        <CheckoutDialog open={checkingOut} onOpenChange={setCheckingOut} pull={pull} actions={actions} />
      ) : null}
    </header>
  );
}

/** Asks before checking a pull request out in the folder, which switches the folder's branch. */
function CheckoutDialog({
  open,
  onOpenChange,
  pull,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pull: PullRequestDetail;
  actions: PullActions;
}) {
  const [done, setDone] = useState<string>();
  const checkout = async () => {
    const branch = await actions.checkout();
    if (branch !== undefined) setDone(branch);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (actions.busy === "checkout") return;
        onOpenChange(next);
        if (!next) setDone(undefined);
      }}
      title={done === undefined ? `Check out #${pull.number} here?` : "Checked out"}
      description={
        done === undefined ? (
          <>
            This folder switches to the pull request's branch,{" "}
            <code className="font-mono text-meta">{pull.head}</code>, as{" "}
            <code className="font-mono text-meta">gh pr checkout</code> does. Changes you haven't committed
            stay with you, unless they clash with the branch.
          </>
        ) : (
          <>
            This folder is on <code className="font-mono text-meta">{done}</code> now.
          </>
        )
      }
      onSubmit={() => (done === undefined ? void checkout() : onOpenChange(false))}
      actions={
        <DialogButton type="submit" tone="primary" disabled={actions.busy !== undefined}>
          {done !== undefined ? "Done" : actions.busy === "checkout" ? "Checking out…" : "Check out"}
        </DialogButton>
      }
    >
      {actions.error === undefined || done !== undefined ? null : (
        <p role="alert" className="text-meta text-error">
          {actions.error}
        </p>
      )}
    </FormDialog>
  );
}

/** The pull request's title, state, branches, and who reviews it. */
function TitleBlock({ pull }: { pull: PullRequestDetail }) {
  const state = pullStateOf(pull);
  const commits = pull.commitCount === 1 ? "1 commit" : `${pull.commitCount} commits`;
  const head =
    pull.headRepository === undefined ? pull.head : `${pull.headRepository.split("/")[0]}:${pull.head}`;
  return (
    <div className="flex flex-col gap-4">
      <ViewerTitle title={pull.title} number={pull.number}>
        <PullStateBadge state={state} />
        <span className="min-w-0">
          <span className="font-medium text-fg-secondary">
            {state === "merged" ? loginOf(pull.mergedBy ?? pull.author) : loginOf(pull.author)}
          </span>{" "}
          {state === "merged" ? `merged ${commits}` : `wants to merge ${commits}`} into{" "}
          <CodeName>{pull.base}</CodeName> from <CodeName>{head}</CodeName>
        </span>
        <span className="flex items-center gap-2.5 whitespace-nowrap">
          {state === "merged" && pull.mergedAt !== undefined ? (
            <When at={pull.mergedAt} />
          ) : state === "closed" && pull.closedAt !== undefined ? (
            <When at={pull.closedAt} />
          ) : (
            <When at={pull.createdAt} />
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono text-meta tabular-nums">
            <span className="text-success">+{pull.additions}</span>{" "}
            <span className="text-error">−{pull.deletions}</span>
          </span>
        </span>
      </ViewerTitle>
      <PullFacts pull={pull} />
    </div>
  );
}

const reviewerLook: Record<Reviewer["state"], { icon: LucideIcon; tone: string; word: string }> = {
  approved: { icon: CircleCheck, tone: "text-success", word: "approved" },
  changesRequested: { icon: CircleX, tone: "text-error", word: "requested changes" },
  commented: { icon: MessageSquare, tone: "text-fg-tertiary", word: "commented" },
  dismissed: { icon: CircleSlash, tone: "text-fg-tertiary", word: "review dismissed" },
  requested: { icon: CircleDashed, tone: "text-attention", word: "review requested" },
};

/** Who reviews it and who it's assigned to, its labels and milestone: the lines that have something. */
function PullFacts({ pull }: { pull: PullRequestDetail }) {
  if (
    pull.reviewers.length === 0 &&
    pull.assignees.length === 0 &&
    pull.labels.length === 0 &&
    pull.milestone === undefined
  ) {
    return null;
  }
  return (
    <Facts>
      {pull.reviewers.length === 0 ? null : (
        <Fact name="Reviewers">
          {pull.reviewers.map((reviewer) => {
            const { icon: Icon, tone, word } = reviewerLook[reviewer.state];
            const user = {
              login: reviewer.name,
              ...(reviewer.avatarUrl ? { avatarUrl: reviewer.avatarUrl } : {}),
            };
            return (
              <Tooltip key={reviewer.name} label={`${reviewer.name} ${word}`}>
                {reviewer.team === true ? (
                  <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-subtle py-0.5 pr-2 pl-0.5">
                    <span className="grid size-5 place-items-center rounded-full bg-surface-hover text-[10px] text-fg-tertiary">
                      #
                    </span>
                    <span className="text-fg-primary">{reviewer.name}</span>
                    <Icon size={12} strokeWidth={2.25} className={tone} />
                  </span>
                ) : (
                  <span className="inline-flex">
                    <PersonChip user={user}>
                      <Icon size={12} strokeWidth={2.25} className={tone} />
                    </PersonChip>
                  </span>
                )}
              </Tooltip>
            );
          })}
        </Fact>
      )}
      {pull.assignees.length === 0 ? null : (
        <Fact name="Assignees">
          {pull.assignees.map((user) => (
            <PersonChip key={user.login} user={user} />
          ))}
        </Fact>
      )}
      {pull.labels.length === 0 ? null : (
        <Fact name="Labels">
          {pull.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </Fact>
      )}
      {pull.milestone === undefined ? null : (
        <Fact name="Milestone">
          <span className="text-fg-primary">{pull.milestone}</span>
        </Fact>
      )}
    </Facts>
  );
}

/** The conversation, then where the pull request stands, then the box to comment in. */
function PullConversation({
  cwd,
  id,
  pull,
  repository,
  actions,
  onShowChecks,
}: {
  cwd: string;
  id: string;
  pull: PullRequestDetail;
  repository: GitHubRepository | undefined;
  actions: PullActions;
  onShowChecks: () => void;
}) {
  const byReview = threadsByReview(pull.threads);
  const renderAfter = (item: PullRequestDetail["timeline"][number]) => {
    if (item._tag !== "Review") return null;
    const threads = byReview.get(item.id);
    return threads === undefined ? null : <Threads threads={threads} actions={actions} />;
  };
  return (
    <div className="flex flex-col gap-5">
      <Conversation
        description={{
          author: pull.author,
          body: pull.body,
          at: pull.createdAt,
          edited: pull.edited,
          association: pull.association,
          reactions: pull.reactions,
          url: pull.url,
        }}
        items={pull.timeline}
        renderAfter={renderAfter}
      />
      {pull.timelineNext === undefined ? null : (
        <MoreTimeline cwd={cwd} number={pull.number} after={pull.timelineNext} renderAfter={renderAfter} />
      )}
      {pull.state === "open" && repository ? (
        <MergeBox pull={pull} repository={repository} actions={actions} onShowChecks={onShowChecks} />
      ) : null}
      {repository ? <PullComposer id={id} pull={pull} repository={repository} actions={actions} /> : null}
    </div>
  );
}

function Threads({ threads, actions }: { threads: ReadonlyArray<ReviewThread>; actions: PullActions }) {
  return (
    <div className="flex flex-col gap-2 pl-10">
      {threads.map((thread) => (
        <ReviewThreadCard key={thread.id} thread={thread} actions={actions} />
      ))}
    </div>
  );
}

/** The conversation past its first page, a page at a time as the user asks for it. */
function MoreTimeline({
  cwd,
  number,
  after,
  renderAfter,
}: {
  cwd: string;
  number: number;
  after: string;
  renderAfter: (item: PullRequestDetail["timeline"][number]) => ReactNode;
}) {
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <Button
        onClick={() => setShown(true)}
        className="self-center rounded-lg border border-line-subtle px-3 py-1.5 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        Show more of the conversation
      </Button>
    );
  }
  return <TimelinePage cwd={cwd} number={number} after={after} renderAfter={renderAfter} />;
}

function TimelinePage({
  cwd,
  number,
  after,
  renderAfter,
}: {
  cwd: string;
  number: number;
  after: string;
  renderAfter: (item: PullRequestDetail["timeline"][number]) => ReactNode;
}) {
  const result = useAtomValue(pullTimelineAtom(pullTimelineKey(pullKey(cwd, number), after)));
  const page = AsyncResult.getOrElse(result, () => undefined);
  if (page === undefined) {
    return (
      <p
        className={`text-center text-meta ${AsyncResult.isFailure(result) ? "text-error" : "text-fg-tertiary"}`}
      >
        {AsyncResult.isFailure(result)
          ? failureMessage(result.cause, "More of the conversation couldn't be read.")
          : "Reading on…"}
      </p>
    );
  }
  return (
    <>
      <Conversation items={page.items} renderAfter={renderAfter} />
      {page.next === undefined ? null : (
        <MoreTimeline cwd={cwd} number={number} after={page.next} renderAfter={renderAfter} />
      )}
    </>
  );
}
