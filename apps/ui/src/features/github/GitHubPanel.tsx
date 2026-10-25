import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { GitHubRepository } from "@cerium/rpc";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import {
  branchPullAtom,
  githubRepositoryAtom,
  githubStatusAtom,
  refreshGitHubRepository,
  refreshPullList,
} from "../../backend/github.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { CreatePullDialog } from "./CreatePullDialog.tsx";
import { GitHubSignIn } from "./GitHubSignIn.tsx";
import { githubErrorOf } from "./model.ts";
import { PullRequestList } from "./PullRequestList.tsx";

type Tab = "pulls" | "issues";

/** The tab the panel shows, kept while the window is open. */
const tabAtom = Atom.make<Tab>("pulls").pipe(Atom.keepAlive);

const toggleClass =
  "shrink-0 rounded-md px-2 py-0.5 text-body font-medium whitespace-nowrap text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[15px]";

/**
 * GitHub, beside the conversation: the pull requests and issues of the repository the open work
 * thread's folder is in, through the machine's own GitHub CLI. Until `gh` can answer for the folder,
 * it says what's missing and offers the fix.
 */
export function GitHubPanel({
  cwd,
  issues,
  openPull,
  onOpenPull,
  onClose,
}: {
  /** The open work thread's folder, its worktree's when it has one. */
  cwd: string;
  /** The Issues tab, given the repository, and how to read it again. */
  issues?: ((repository: GitHubRepository) => { content: ReactNode; refresh: () => void }) | undefined;
  /** The pull request whose tab shows. */
  openPull: number | undefined;
  /** Opens a pull request in a tab, named after its title when that's known. */
  onOpenPull: (number: number, title?: string) => void;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [tab, setTab] = useAtom(tabAtom);
  const result = useAtomValue(githubRepositoryAtom(cwd));
  const repository = AsyncResult.getOrElse(result, () => undefined);
  const branch = AsyncResult.getOrElse(useAtomValue(branchPullAtom(cwd)), () => undefined);
  const [creating, setCreating] = useState(false);
  const issuesTab = repository && issues ? issues(repository) : undefined;
  const shown = issuesTab === undefined ? "pulls" : tab;
  const element = useRef<HTMLDivElement>(null);

  const refresh = () => {
    refreshGitHubRepository(registry, cwd);
    registry.refresh(githubStatusAtom);
    if (shown === "pulls") refreshPullList(registry, cwd);
    else issuesTab?.refresh();
  };

  // Esc closes the panel while focus is inside it, unless something there (a field, a menu) used the key first.
  const onEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      element.current?.contains(document.activeElement)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div ref={element} className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2 max-md:h-12 max-md:pl-3">
        {issuesTab === undefined ? (
          <h2 className="truncate px-1 text-body font-medium text-fg-primary max-md:text-[15px]">
            {repository ? "Pull requests" : "GitHub"}
          </h2>
        ) : (
          <ToggleGroup
            value={[shown]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "pulls" || next === "issues") setTab(next);
            }}
            aria-label="Show"
            className="flex items-center"
          >
            <Toggle value="pulls" className={toggleClass}>
              Pull requests
            </Toggle>
            <Toggle value="issues" className={toggleClass}>
              Issues
            </Toggle>
          </ToggleGroup>
        )}
        <span className="ml-auto" />
        {repository ? (
          <IconButton
            icon={ExternalLink}
            label={`Open ${repository.owner}/${repository.name} on GitHub`}
            onClick={() => window.open(repository.url, "_blank", "noopener,noreferrer")}
            className="max-md:size-10"
          />
        ) : null}
        <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} className="max-md:size-10" />
        <IconButton icon={X} label="Close" onClick={onClose} className="max-md:size-10" />
      </header>
      <div className="min-h-0 flex-1">
        {repository ? (
          shown === "issues" && issuesTab ? (
            issuesTab.content
          ) : (
            <PullRequestList
              cwd={cwd}
              repository={repository}
              openNumber={openPull}
              onOpen={onOpenPull}
              onCreate={() => setCreating(true)}
            />
          )
        ) : AsyncResult.isFailure(result) ? (
          <Gate cause={result.cause} onRetry={refresh} />
        ) : (
          <p className="px-4 py-8 text-center text-meta text-fg-tertiary">Finding the repository…</p>
        )}
      </div>
      {repository && branch?.branch !== undefined ? (
        <CreatePullDialog
          // A branch switched to starts the form over.
          key={branch.branch}
          cwd={cwd}
          repository={repository}
          branch={branch}
          open={creating}
          onOpenChange={setCreating}
          onCreated={onOpenPull}
        />
      ) : null}
    </div>
  );
}

const GH_INSTALL_URL = "https://cli.github.com";

/** What stops the panel from showing the repository, and the way past it. */
function Gate({ cause, onRetry }: { cause: Parameters<typeof githubErrorOf>[0]; onRetry: () => void }) {
  const error = githubErrorOf(cause);
  const retry = (
    <Button
      onClick={onRetry}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-line-subtle px-3 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      <RefreshCw size={13} strokeWidth={1.75} />
      Check again
    </Button>
  );
  switch (error?.reason) {
    case "missing":
      return (
        <Notice
          title="GitHub CLI isn't installed"
          body="Pull requests and issues go through GitHub's own CLI, gh, which keeps your sign-in."
        >
          <a
            href={GH_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            <ExternalLink size={13} strokeWidth={2} />
            Get GitHub CLI
          </a>
          {retry}
        </Notice>
      );
    case "signedOut":
      return (
        <Notice title="Sign in to GitHub" body={error.message}>
          <GitHubSignIn onSignedIn={onRetry} />
        </Notice>
      );
    case "noRepository":
      return (
        <Notice title="No GitHub repository here" body={error.message}>
          {retry}
        </Notice>
      );
    default:
      return (
        <Notice title="GitHub didn't answer" body={error?.message ?? "The machine couldn't be reached."}>
          {retry}
        </Notice>
      );
  }
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
