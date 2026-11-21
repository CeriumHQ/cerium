import { type ReactNode } from "react";

import { WEB } from "../backend/target.ts";
import { leadOf, modelLabel } from "../backend/view.ts";
import { reachOf } from "../features/account/model.ts";
import { isNewDraftKey } from "../features/composer/drafts.ts";
import { taskFromIssue } from "../features/tasks/tasks.ts";
import type { PaletteCommand } from "../features/palette/palette.ts";
import { GitHubTabView } from "../features/github/GitHubTab.tsx";
import { githubOfKey, type GitHubTab } from "../features/github/model.ts";
import { IssueViewer } from "../features/issues/IssueViewer.tsx";
import { CloudThreadBar, LoadingThreadBar, NoComputerBar } from "../features/threads/CloudThread.tsx";
import { ThreadMark } from "../features/threads/StatusIndicator.tsx";
import { type PaneLeaf } from "../features/split/model.ts";
import { type PaneChrome, type PaneLabel } from "../features/split/SplitView.tsx";
import { FileViewer } from "../features/viewer/FileViewer.tsx";
import { commitFileOfKey, fileOfKey, turnFileOfKey } from "../features/viewer/model.ts";
import { TurnFileView } from "../features/viewer/TurnFileView.tsx";
import { CommitFileView } from "../features/git/history/CommitFileView.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { CrashGuard } from "../features/crash/CrashGuard.tsx";
import { PaneCrash } from "../features/crash/CrashViews.tsx";
import { ThreadPane, type ThreadPaneActions } from "./ThreadPane.tsx";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";
import type { WorkspacePanels } from "./useWorkspacePanels.ts";
import type { WorkspaceTools } from "./useWorkspaceTools.tsx";
import type { WorkspacePlaces } from "./useWorkspacePlaces.ts";
import type { WorkspacePreview } from "./useWorkspacePreview.tsx";

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function workspacePaneViews({
  driven,
  solo,
  sessionState,
  threads,
  tabView,
  composer,
  panels,
  places,
  tools,
  preview,
  paneActions,
  slashCommands,
  notices,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly composer: WorkspaceComposer;
  readonly panels: WorkspacePanels;
  readonly places: WorkspacePlaces;
  readonly tools: WorkspaceTools;
  readonly preview: WorkspacePreview;
  readonly paneActions: ThreadPaneActions;
  readonly slashCommands: ReadonlyArray<PaletteCommand>;
  readonly notices: ReactNode;
}) {
  const { current, mode, openDraft, defaultFolder } = sessionState;
  const { resolve, drivenId, nameOf, deviceOf, available, models, projectOf } = threads;
  const { tabs, openOn, startNew, startThreadFrom, openThreadById, worktreesOk } = tabView;
  const { messageBox, routedDraftKey, onPaneHandles } = composer;
  const { inspectedAgent, setInspectedAgent } = panels;
  const { openTask, openCapturedTask } = places;
  const { terminal, setupRun, issuesOk, openGitHubIn, openerIn } = tools;
  /** Where a thread can't take messages here, what shows in place of its message box. */
  const barFor = ({ cloud, loading }: ReturnType<typeof resolve>, lead: boolean): ReactNode => {
    if (WEB && driven === undefined && !cloud) return <NoComputerBar />;
    if (loading) return <LoadingThreadBar />;
    if (cloud === undefined) return undefined;
    const device = deviceOf(cloud.machine);
    /** The thread's machine is the one the window drives, and it hasn't answered yet. */
    const connecting =
      cloud.machine === drivenId && device !== undefined && reachOf(device).kind === "reachable";
    if (connecting && lead) return undefined;
    return (
      <CloudThreadBar
        machine={nameOf(cloud.machine)}
        reach={device ? reachOf(device) : { kind: "offline", presence: "Not connected" }}
        connecting={cloud.machine === drivenId}
        onOpen={() => {
          if (device) openOn(device, cloud.overview.thread.id);
        }}
        onStartNew={startNew}
      />
    );
  };
  /** A pane showing the thread, or the thread not started yet, `key`. */
  const threadPane = (key: string, focused: boolean) => {
    const resolved = resolve(key);
    const lead = resolved.shown ? leadOf(resolved.shown.agents) !== undefined : false;
    // A thread's own window keeps them with its thread, whichever pane has the focus.
    const opened = key === (solo?.id ?? current);
    const previewPane = preview.paneFor(resolved);
    return (
      <ThreadPane
        inspectedAgent={inspectedAgent}
        onLeaveAgent={() => setInspectedAgent(undefined)}
        onOpenTask={openTask}
        onAddTask={openCapturedTask}
        mode={mode}
        selected={resolved.listed}
        cloud={
          resolved.cloud
            ? {
                machine: resolved.cloud.machine,
                name: nameOf(resolved.cloud.machine),
                overview: resolved.cloud.overview,
              }
            : undefined
        }
        loading={resolved.loading}
        draftKey={isNewDraftKey(key) ? key : opened ? openDraft : key}
        folder={defaultFolder}
        available={available}
        worktrees={worktreesOk}
        bar={barFor(resolved, lead)}
        // The window's notices and its terminal go with the open thread.
        {...(opened ? { notices, drawer: terminal.drawer } : {})}
        {...(opened && setupRun !== undefined ? { setup: setupRun } : {})}
        {...(previewPane === undefined ? {} : { preview: previewPane })}
        focused={focused}
        paneKey={key}
        onHandles={onPaneHandles}
        actions={paneActions}
        slashCommands={slashCommands}
      />
    );
  };
  /**
   * What a pane shows, which takes only its own pane down if it throws while drawing. The guard isn't
   * keyed by the tab, so a thread pane stays mounted, with the threads it keeps drawn, as tabs switch.
   */
  const paneContent = (key: string, focused: boolean, chrome?: PaneChrome) => (
    <CrashGuard resetKey={key} fallback={PaneCrash}>
      {paneView(key, focused, chrome)}
    </CrashGuard>
  );
  const paneView = (key: string, focused: boolean, chrome?: PaneChrome) => {
    const github = githubOfKey(key);
    if (github !== undefined) {
      return (
        <GitHubTabView
          onOpenThread={openThreadById}
          key={key}
          tab={github}
          worktrees={worktreesOk}
          onStartThread={({ text, worktree, workspace }) =>
            startThreadFrom({ folder: github.root, text, worktree, ...(workspace ? { workspace } : {}) })
          }
          {...(issuesOk
            ? {
                issue: (tab: GitHubTab, pane: PaneChrome | undefined) => (
                  <IssueViewer
                    cwd={tab.root}
                    number={tab.number}
                    onClose={() => tabs.actions.onClose([key])}
                    onStartThread={(text) => startThreadFrom({ folder: tab.root, text })}
                    onAddTask={(issue) => openCapturedTask(taskFromIssue(issue, projectOf(tab.root)))}
                    onOpenPull={(number) => openGitHubIn(tab.root, "pr", number)}
                    pane={pane}
                  />
                ),
              }
            : {})}
          onClose={() => tabs.actions.onClose([key])}
          pane={chrome}
        />
      );
    }
    const commit = commitFileOfKey(key);
    if (commit !== undefined) {
      return (
        <CommitFileView
          key={key}
          root={commit.root}
          sha={commit.sha}
          path={commit.path}
          from={commit.from}
          onClose={() => tabs.actions.onClose([key])}
          pane={chrome}
        />
      );
    }
    const turn = turnFileOfKey(key);
    if (turn !== undefined) {
      return (
        <TurnFileView
          key={key}
          tab={turn}
          onClose={() => tabs.actions.onClose([key])}
          pane={chrome}
          messageBox={messageBox}
          draftKey={routedDraftKey}
        />
      );
    }
    const file = fileOfKey(key);
    if (file === undefined) return threadPane(key, focused);
    return (
      <FileViewer
        key={key}
        root={file.root}
        path={file.path}
        messageBox={messageBox}
        draftKey={routedDraftKey}
        onOpenFile={openerIn(file.root)}
        onClose={() => tabs.actions.onClose([key])}
        pane={chrome}
      />
    );
  };

  /** What a pane's header calls what it shows. */
  const paneLabel = (leaf: PaneLeaf): PaneLabel => {
    const tab = tabs.tabs.find((each) => each.key === leaf.key);
    const file = fileOfKey(leaf.key) ?? commitFileOfKey(leaf.key) ?? turnFileOfKey(leaf.key);
    if (file !== undefined) {
      // The viewer's own header names the file, and is the pane's.
      return { title: baseName(file.path), detail: tab?.project ?? file.path, ownHeader: true };
    }
    const github = githubOfKey(leaf.key);
    if (github !== undefined) {
      // The viewer's own header names the pull request or issue, and is the pane's.
      return {
        title: tab?.title ?? `#${github.number}`,
        ...(tab?.project ? { detail: tab.project } : {}),
        ownHeader: true,
      };
    }
    const newTitle = mode === "work" ? "New thread" : "New chat";
    if (tab === undefined) return { title: newTitle };
    // Threads side by side often differ only in their model (multi agent), so it leads the detail.
    const shownLead = resolve(leaf.key).shown;
    const lead = shownLead ? leadOf(shownLead.agents) : undefined;
    const detail = [lead ? modelLabel(models, lead.provider, lead.model) : undefined, tab.project]
      .filter((part) => part !== undefined && part !== "")
      .join(" · ");
    return {
      title: tab.title || newTitle,
      ...(detail ? { detail } : {}),
      icon: tab.draft ? undefined : tab.thread ? (
        <ThreadMark thread={tab.thread} unread={tab.unread === true} size="small" />
      ) : tab.provider ? (
        <ProviderLogo provider={tab.provider} size={12} />
      ) : undefined,
    };
  };

  return { paneContent, paneLabel };
}
