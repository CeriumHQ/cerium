import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink, Link, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useContext, useEffect } from "react";

import { githubRepositoryAtom } from "../../backend/github.ts";
import {
  issueAtom,
  issueChoicesAtom,
  issueItemsAtom,
  issueKey,
  readOnIssue,
  refreshIssue,
} from "../../backend/issues.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { useShortcut } from "../../lib/shortcuts.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Conversation } from "../github/Conversation.tsx";
import { githubKey } from "../github/model.ts";
import {
  GitHubLink,
  loginOf,
  MoreMenu,
  StartThreadButton,
  StatePill,
  ViewerTitle,
  When,
} from "../github/parts.tsx";
import { nameGitHubTab } from "../github/tabs.ts";
import type { PaneChrome } from "../split/SplitView.tsx";
import { Note, messageOf } from "../viewer/previews.tsx";
import { IssueComposer } from "./IssueComposer.tsx";
import { IssueMeta } from "./IssueMeta.tsx";
import { ITEMS_LIMIT, canTriage, issueBrief, stateLabel } from "./model.ts";
import { StateIcon } from "./parts.tsx";
import { useIssueActions } from "./useIssueActions.ts";
import { useIssueFreshness } from "./useIssueFreshness.ts";

const openOutside = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

/**
 * A GitHub issue in a tab beside the thread: its title and state, who it is assigned to and how it is
 * labelled, then the description and the conversation, ending in the box to answer in. It follows the
 * issue while it shows, and a thread can be started from it.
 */
export function IssueViewer({
  cwd,
  number,
  onClose,
  onStartThread,
  onOpenPull,
  pane,
}: {
  /** The work thread's folder, whose repository the issue is in. */
  readonly cwd: string;
  readonly number: number;
  readonly onClose: () => void;
  /** Starts a thread that looks into the issue, from the brief it is given. */
  readonly onStartThread: (brief: string) => void;
  /** Opens one of this repository's pull requests in a tab. */
  readonly onOpenPull?: ((number: number) => void) | undefined;
  /** While it shares the main area with other panes, its header is the pane's: dragged by, with the pane's menu. */
  readonly pane?: PaneChrome | undefined;
}) {
  const registry = useContext(RegistryContext);
  const id = issueKey(cwd, number);
  const result = useAtomValue(issueAtom(id));
  const issue = Option.getOrUndefined(AsyncResult.value(result));
  const repository = Option.getOrUndefined(AsyncResult.value(useAtomValue(githubRepositoryAtom(cwd))));
  const choices = Option.getOrUndefined(AsyncResult.value(useAtomValue(issueChoicesAtom(cwd))));
  const asked = useAtomValue(issueItemsAtom(id));
  const actions = useIssueActions(cwd, number);
  useIssueFreshness(cwd, number, issue?.revision);

  // The tab is named after the issue as soon as it has been read, and again if it is renamed.
  const title = issue?.title;
  useEffect(() => {
    if (title !== undefined) nameGitHubTab(registry, githubKey(cwd, "issue", number), title);
  }, [registry, cwd, number, title]);

  const triage = canTriage(repository?.permission);
  const url =
    issue?.url ??
    (repository === undefined ? undefined : `${repository.url.replace(/\/$/, "")}/issues/${number}`);

  const header = (
    <header
      {...pane?.grip}
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12 ${pane ? "select-none" : ""}`}
    >
      {issue === undefined ? null : <StateIcon issue={issue} size={15} />}
      <span className="flex min-w-0 items-baseline gap-1.5 text-body max-md:text-[15px]">
        <span className="shrink-0 text-fg-tertiary tabular-nums">#{number}</span>
        <span className="min-w-0 truncate font-medium text-fg-primary">{issue?.title ?? ""}</span>
      </span>
      {result.waiting && issue !== undefined ? (
        <LoaderCircle
          size={13}
          className="shrink-0 animate-spin text-fg-tertiary"
          aria-label="Reading the issue"
        />
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="ml-1">
          <StartThreadButton
            worktrees={false}
            disabled={issue === undefined}
            onStart={() => issue !== undefined && onStartThread(issueBrief(issue))}
          />
        </span>
        <MoreMenu>
          {url === undefined ? null : (
            <>
              <MenuItem icon={ExternalLink} onClick={() => openOutside(url)}>
                Open on GitHub
              </MenuItem>
              <MenuItem icon={Link} onClick={() => void navigator.clipboard.writeText(url)}>
                Copy link
              </MenuItem>
            </>
          )}
          <MenuItem icon={RefreshCw} onClick={() => refreshIssue(registry, id)}>
            Refresh
          </MenuItem>
          {pane ? (
            <>
              <MenuSeparator />
              {pane.menu}
            </>
          ) : null}
        </MoreMenu>
        <IconButton
          icon={X}
          label="Close"
          shortcut={useShortcut("close-tab")}
          onClick={onClose}
          className="max-md:size-10"
        />
      </span>
    </header>
  );

  const body = (() => {
    if (issue === undefined) {
      if (AsyncResult.isFailure(result)) {
        return (
          <Note
            action={
              <button
                type="button"
                onClick={() => refreshIssue(registry, id)}
                className="rounded-md px-2 py-1 text-body text-fg-primary hover:bg-surface-hover"
              >
                Try again
              </button>
            }
          >
            {messageOf(result.cause, "The issue couldn't be read.")}
          </Note>
        );
      }
      return (
        <output className="grid h-full place-items-center text-fg-tertiary" aria-label="Reading the issue">
          <LoaderCircle size={18} className="animate-spin" />
        </output>
      );
    }
    const more = issue.more === true;
    return (
      <ScrollArea className="h-full">
        <div className="mx-auto flex max-w-[56rem] flex-col gap-5 px-6 pt-5 pb-12 max-md:px-3">
          <ViewerTitle title={issue.title} number={issue.number}>
            <StatePill
              icon={<StateIcon issue={issue} size={13} />}
              label={stateLabel(issue)}
              tone={issue.state === "open" ? "text-success" : "text-fg-secondary"}
            />
            <span>
              <span className="font-medium text-fg-secondary">{loginOf(issue.author)}</span> opened this{" "}
              <When at={issue.createdAt} />
            </span>
            <span aria-hidden>·</span>
            <span>
              {issue.comments} {issue.comments === 1 ? "comment" : "comments"}
            </span>
            {issue.closedAt === undefined || issue.state === "open" ? null : (
              <>
                <span aria-hidden>·</span>
                <span>
                  closed <When at={issue.closedAt} />
                </span>
              </>
            )}
          </ViewerTitle>
          <IssueMeta
            cwd={cwd}
            issue={issue}
            triage={triage}
            me={choices?.me.login ?? repository?.viewer}
            actions={actions}
            onOpenPull={onOpenPull}
          />
          <Conversation
            description={{
              author: issue.author,
              body: issue.body,
              at: issue.createdAt,
              edited: issue.edited,
              association: issue.association,
              reactions: issue.reactions,
              url: issue.url,
            }}
            items={issue.timeline}
            footer={
              <div className="flex flex-col gap-4">
                {!more ? null : asked < ITEMS_LIMIT ? (
                  <button
                    type="button"
                    onClick={() => readOnIssue(registry, id, ITEMS_LIMIT)}
                    className="self-center rounded-md px-2.5 py-1 text-body text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                  >
                    Show more of the conversation
                  </button>
                ) : (
                  <p className="text-center text-body text-fg-tertiary">
                    The rest of the conversation is{" "}
                    <GitHubLink href={issue.url} className="text-fg-secondary underline underline-offset-2">
                      on GitHub
                    </GitHubLink>
                    .
                  </p>
                )}
                <IssueComposer id={id} issue={issue} triage={triage} actions={actions} />
              </div>
            }
          />
        </div>
      </ScrollArea>
    );
  })();

  return (
    <section aria-label={`Issue ${number}`} className="flex h-full flex-col">
      {pane ? <ContextMenuArea menu={pane.menu}>{header}</ContextMenuArea> : header}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
