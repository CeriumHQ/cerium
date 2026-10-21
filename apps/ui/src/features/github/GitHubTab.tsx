import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, type ReactNode } from "react";

import { pullAtom, pullKey } from "../../backend/github.ts";
import type { PaneChrome } from "../split/SplitView.tsx";
import { Note } from "../viewer/previews.tsx";
import { githubKey, type GitHubTab } from "./model.ts";
import { PullRequestViewer, type PullThreadStart } from "./PullRequestViewer.tsx";
import { nameGitHubTab } from "./tabs.ts";

/**
 * A GitHub tab in the main area: a pull request's viewer, or an issue's. Either names its tab once
 * it has read what it shows.
 */
export function GitHubTabView({
  tab,
  worktrees,
  onStartThread,
  issue,
  onClose,
  pane,
}: {
  tab: GitHubTab;
  /** A thread can start in a worktree of its own. */
  worktrees: boolean;
  onStartThread: ((start: PullThreadStart) => void) | undefined;
  /** The issue viewer, where the window has one. */
  issue?: ((tab: GitHubTab, pane: PaneChrome | undefined) => ReactNode) | undefined;
  onClose: () => void;
  pane?: PaneChrome | undefined;
}) {
  if (tab.kind === "issue") {
    return issue ? issue(tab, pane) : <Note>Issues can't open here.</Note>;
  }
  return (
    <>
      <PullTitle cwd={tab.root} number={tab.number} />
      <PullRequestViewer
        cwd={tab.root}
        number={tab.number}
        worktrees={worktrees}
        onStartThread={onStartThread}
        onClose={onClose}
        pane={pane}
      />
    </>
  );
}

/** Names a pull request's tab after it, from the reading its viewer makes. */
function PullTitle({ cwd, number }: { cwd: string; number: number }) {
  const registry = useContext(RegistryContext);
  const title = AsyncResult.getOrElse(useAtomValue(pullAtom(pullKey(cwd, number))), () => undefined)?.title;
  useEffect(() => {
    if (title !== undefined) nameGitHubTab(registry, githubKey(cwd, "pr", number), title);
  }, [registry, cwd, number, title]);
  return null;
}
