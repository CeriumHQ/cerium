import { type AgentEvent, type ThreadId } from "@cerium/protocol";
import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { artifactEventsAtom, sendMessage } from "../backend/atoms.ts";
import { refreshIssueList } from "../backend/issues.ts";
import { machineAtom } from "../backend/machine.ts";
import {
  noProjectScripts,
  projectScriptsAtom,
  runProjectAction,
  runProjectScript,
} from "../backend/scripts.ts";
import { leadOf } from "../backend/view.ts";
import {
  ARTIFACTS_VERSION,
  revealArtifact,
  threadArtifacts,
  type PanelArtifact,
} from "../features/artifacts/model.ts";
import { isNewDraftKey } from "../features/composer/drafts.ts";
import { appendAgentText, type AskAgentFix } from "../features/composer/agentFix.ts";
import type { MessageBox } from "../features/composer/messageBox.ts";
import { AUTOMATIONS_VERSION, GITHUB_AUTOMATIONS_VERSION } from "../backend/automations.ts";
import { FILES_VERSION, type OpenFile } from "../features/files/model.ts";
import { useFilesExplorer } from "../features/files/useFilesExplorer.tsx";
import { GIT_VERSION } from "../features/git/model.ts";
import { useSourceControl } from "../features/git/useSourceControl.tsx";
import { GitHubPanel } from "../features/github/GitHubPanel.tsx";
import { GITHUB_VERSION, githubKey, githubOfKey, type GitHubKind } from "../features/github/model.ts";
import { nameGitHubTab } from "../features/github/tabs.ts";
import { IssuesTab } from "../features/issues/IssuesTab.tsx";
import { ISSUES_VERSION } from "../features/issues/model.ts";
import {
  ACTIONS_VERSION,
  PROJECT_TERMINAL_VERSION,
  SCRIPT_VERSION,
  TERMINAL_VERSION,
  labelledTerminalOf,
  scriptTerminalOf,
} from "../features/terminal/model.ts";
import { fittedSize } from "../features/terminal/session.ts";
import { closeTerminal, terminalsAtom } from "../backend/terminals.ts";
import { useTerminalDrawer } from "../features/terminal/useTerminalDrawer.tsx";
import {
  commitFileKey,
  fileKey,
  fileViewAtom,
  turnFileKey,
  VIEWER_VERSION,
  type TurnFileTab,
} from "../features/viewer/model.ts";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import { type SetupRun } from "./ThreadPane.tsx";
import { soloThread } from "./threadWindow.ts";

import type { DrivenMachine } from "../backend/machine.ts";
import type { WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";
import type { WorkspacePanels } from "./useWorkspacePanels.ts";
import { messageOf, type useWorkspaceErrors } from "./workspaceErrors.ts";

export function useWorkspaceTools({
  driven,
  compact,
  sessionState,
  threads,
  tabView,
  composer,
  panels,
  errors,
  settingsOpen,
  searchOpen,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly compact: boolean;
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly composer: WorkspaceComposer;
  readonly panels: WorkspacePanels;
  readonly errors: ReturnType<typeof useWorkspaceErrors>;
  readonly settingsOpen: boolean;
  readonly searchOpen: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { current, openFile, openCommitRoot, newProject, defaultFolder, projects } = sessionState;
  const {
    selected,
    viewed,
    cloudSelected,
    cloudEvents,
    drivenDevice,
    overviews,
    summaries,
    fileEvents,
    resolve,
  } = threads;
  const { showTab, openSummary } = tabView;
  const { composerPanes, handlesOf, messageBox, lastThreadKey } = composer;
  const { filesOpen, gitOpen, githubOpen, closePanel, setSidePanel } = panels;
  const { attempt, setActionError } = errors;
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const solo = soloThread;
  /**
   * The open work thread's folder, the open file's, or the project of the new work thread being
   * written, can be browsed here: it's on the machine the window drives, which knows how.
   */
  const filesRoot =
    drivenDevice !== undefined && (drivenDevice.rpcVersion ?? 0) < FILES_VERSION
      ? undefined
      : selected?.thread.mode === "work" && selected.thread.cwd !== undefined
        ? selected.thread.cwd
        : (openFile?.root ?? openCommitRoot ?? newProject);
  /** Its files open in Cerium's viewer, when the machine can serve them. */
  const viewerOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= VIEWER_VERSION;
  const fileRoots = viewerOk
    ? [...new Set([filesRoot ?? defaultFolder, ...projects])].filter((path) => path !== undefined)
    : [];
  /** Opens the folder `root`'s files in the viewer. */
  const openerIn =
    (root: string): OpenFile =>
    (path, options) => {
      const key = fileKey(root, path);
      // From the Changes list, a file opens on what changed.
      if (options?.changes === true) registry.set(fileViewAtom(key), "diff");
      showTab(key);
    };
  const openInViewer = filesRoot === undefined || !viewerOk ? undefined : openerIn(filesRoot);
  /** Opens the folder `root`'s file as one commit changed it, in a tab of its own, as the viewer's files open. */
  const openCommitFileIn =
    (root: string) => (sha: string, file: { readonly path: string; readonly from?: string }) =>
      showTab(commitFileKey(root, sha, file.path, file.from));
  /** Opens a file as one of an agent's turns changed it, in a tab of its own, as a commit's files open. */
  const openTurnFile = (tab: TurnFileTab) => showTab(turnFileKey(tab));
  /** The open work thread's repository, which Source control shows where its machine can. */
  const gitRoot =
    drivenDevice !== undefined && (drivenDevice.rpcVersion ?? 0) < GIT_VERSION ? undefined : filesRoot;
  // Terminal output goes to the open thread or project draft; commit failures also reach the last
  // thread in the same repository when the user opened a file or commit diff tab to inspect changes.
  const fixPaneKey = selected?.thread.id ?? (newProject === undefined ? undefined : current);
  const hasFixComposer = fixPaneKey !== undefined && composerPanes.has(fixPaneKey);
  const appendDraftTo =
    (paneKey: string | undefined): MessageBox["append"] =>
    (content) => {
      const box = handlesOf(paneKey)?.box;
      if (box?.key() === undefined) throw new Error("The thread's message box is unavailable.");
      box.append(content);
    };
  const appendFixDraft = appendDraftTo(fixPaneKey);
  const fixLead = selected === undefined || cloudSelected !== undefined ? undefined : leadOf(selected.agents);
  const canAskFix = fixLead !== undefined || hasFixComposer;
  const askFixFor =
    (lead: ReturnType<typeof leadOf>, paneKey: string | undefined): AskAgentFix =>
    async (text) => {
      if (registry.get(machineAtom)?.id !== driven?.id) throw new Error("The thread's machine has changed.");
      if (lead !== undefined) {
        await send({ payload: { agentId: lead.id, text } });
        return "sent";
      }
      appendAgentText({ append: appendDraftTo(paneKey) }, text);
      return "draft";
    };
  const askFix = askFixFor(fixLead, fixPaneKey);
  const commitFixThread =
    selected ??
    (gitRoot !== undefined && isNonThreadKey(current) && lastThreadKey !== undefined
      ? (() => {
          const { listed, cloud } = resolve(lastThreadKey);
          return listed !== undefined &&
            cloud === undefined &&
            listed.thread.mode === "work" &&
            listed.thread.cwd === gitRoot
            ? listed
            : undefined;
        })()
      : undefined);
  const commitFixLead =
    commitFixThread === undefined || (commitFixThread === selected && cloudSelected !== undefined)
      ? undefined
      : leadOf(commitFixThread.agents);
  const commitFixPaneKey =
    commitFixThread?.thread.id ??
    (newProject !== undefined
      ? current
      : gitRoot !== undefined &&
          isNonThreadKey(current) &&
          lastThreadKey !== undefined &&
          isNewDraftKey(lastThreadKey)
        ? lastThreadKey
        : undefined);
  const hasCommitFixComposer = commitFixPaneKey !== undefined && composerPanes.has(commitFixPaneKey);
  const canAskCommitFix = commitFixLead !== undefined || hasCommitFixComposer;
  const askCommitFix = askFixFor(commitFixLead, commitFixPaneKey);
  // Its shells run on the same machine, in the same folder; a new work thread's, in its project.
  const terminalsOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= TERMINAL_VERSION;
  const projectTerminalsOk =
    drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= PROJECT_TERMINAL_VERSION;
  const terminal = useTerminalDrawer({
    owner:
      filesRoot === undefined || !terminalsOk
        ? undefined
        : selected !== undefined
          ? { threadId: selected.thread.id }
          : newProject !== undefined && projectTerminalsOk
            ? { project: newProject }
            : undefined,
    suspended: settingsOpen || searchOpen,
    compact,
    messageBox: hasFixComposer ? { append: appendFixDraft } : undefined,
    onAskFix: canAskFix ? askFix : undefined,
  });
  /** This machine can run a project's scripts, in the thread's terminal drawer. */
  const scriptsOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= SCRIPT_VERSION;
  /** The work thread that can run its project's scripts: local, a work thread, in a folder. */
  const runThreadId =
    selected !== undefined &&
    cloudSelected === undefined &&
    scriptsOk &&
    selected.thread.mode === "work" &&
    selected.thread.cwd !== undefined
      ? (selected.thread.id as ThreadId)
      : undefined;
  /** The thread's project run, as its terminal has it: running while it has no exit code yet. */
  const machineTerminals = AsyncResult.getOrElse(useAtomValue(terminalsAtom), () => []);
  const runTerminal =
    runThreadId === undefined || selected === undefined
      ? undefined
      : scriptTerminalOf(machineTerminals, { threadId: selected.thread.id }, "run");
  const runRunning = runTerminal !== undefined && runTerminal.exitCode === undefined;
  const runProject = useAtomSet(runProjectScript, { mode: "promise" });
  const endRun = useAtomSet(closeTerminal, { mode: "promise" });
  /** Runs the thread's project run command in a terminal of the thread's, or stops it while it runs. */
  const toggleRun = () => {
    if (runThreadId === undefined) return;
    if (runTerminal === undefined || runTerminal.exitCode !== undefined) {
      void attempt(runProject({ payload: { threadId: runThreadId, kind: "run", size: fittedSize() } }));
    } else {
      void attempt(endRun({ payload: { id: runTerminal.id } }));
    }
  };
  /** Installs what the thread's project needs, in a terminal of the thread's. */
  const setupProject = () => {
    if (runThreadId === undefined) return;
    void attempt(runProject({ payload: { threadId: runThreadId, kind: "setup", size: fittedSize() } }));
  };
  /** The folder the thread's project was picked by, which its scripts and actions resolve from. */
  const scriptsProject =
    selected === undefined ? undefined : (selected.thread.worktree?.project ?? selected.thread.cwd);
  const actionsOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= ACTIONS_VERSION;
  const projectScriptsFor =
    runThreadId === undefined || scriptsProject === undefined || !actionsOk
      ? noProjectScripts
      : projectScriptsAtom(scriptsProject);
  const projectScripts = AsyncResult.getOrElse(useAtomValue(projectScriptsFor), () => undefined);
  /** The thread's project setup while it runs: the lead may wait on it, and it on the user's input. */
  const setupTerminal =
    runThreadId === undefined || selected === undefined
      ? undefined
      : scriptTerminalOf(machineTerminals, { threadId: selected.thread.id }, "setup");
  const setupRun: SetupRun | undefined =
    setupTerminal === undefined || setupTerminal.exitCode !== undefined || !terminal.available
      ? undefined
      : {
          id: setupTerminal.id,
          command: projectScripts?.setup?.text,
          startedAt: setupTerminal.openedAt,
          onShow: () => terminal.reveal(setupTerminal.id),
        };
  /** The project's named actions (Test, Lint, Migrate), each with whether its terminal is running. */
  const projectActions = (projectScripts?.actions ?? []).map((action) => {
    const own =
      selected === undefined
        ? undefined
        : labelledTerminalOf(machineTerminals, { threadId: selected.thread.id }, action.name);
    return { name: action.name, running: own !== undefined && own.exitCode === undefined };
  });
  const refreshProjectScripts = useAtomRefresh(projectScriptsFor);
  const runAction = useAtomSet(runProjectAction, { mode: "promise" });
  /** Runs one of the project's actions in a terminal of the thread's, labelled with its name, or stops it while it runs. */
  const toggleAction = (name: string) => {
    if (runThreadId === undefined || selected === undefined) return;
    const own = labelledTerminalOf(machineTerminals, { threadId: selected.thread.id }, name);
    if (own !== undefined && own.exitCode === undefined) {
      void attempt(endRun({ payload: { id: own.id } }));
    } else {
      // Its output is what the user wants to see: the drawer opens on the action's terminal.
      void runAction({ payload: { threadId: runThreadId, name, size: fittedSize() } }).then(
        (started) => {
          setActionError(undefined);
          terminal.reveal(started.id);
        },
        (error: unknown) => setActionError(messageOf(error)),
      );
    }
  };
  const filesPanel = useFilesExplorer({
    root: filesRoot,
    events: fileEvents,
    messageBox,
    open: filesOpen && !settingsOpen,
    onOpenFile: openInViewer,
    activePath: openFile?.root === filesRoot ? openFile?.path : undefined,
    onClose: () => closePanel("files"),
    ...(gitRoot === undefined ? {} : { onShowChanges: () => setSidePanel("git") }),
  });
  const sourceControl = useSourceControl({
    root: gitRoot,
    open: gitOpen && !settingsOpen,
    openIn: viewerOk ? openerIn : undefined,
    openCommitFile: openCommitFileIn,
    activeFile: openFile,
    review: selected === undefined ? undefined : { threadId: selected.thread.id, messageBox },
    onAskFix: canAskCommitFix
      ? async (text) => {
          const delivered = await askCommitFix(text);
          if (compact && delivered === "draft") {
            if (terminal.open) terminal.hide();
            closePanel("git");
          }
          return delivered;
        }
      : undefined,
    onClose: () => closePanel("git"),
  });
  /** The pull request or issue the open tab shows, when it shows one. */
  const openGitHub = githubOfKey(current);
  /**
   * The open work thread's folder, or the open pull request's or issue's, whose GitHub repository the
   * GitHub panel shows where its machine can.
   */
  const githubRoot =
    drivenDevice !== undefined && (drivenDevice.rpcVersion ?? 0) < GITHUB_VERSION
      ? undefined
      : (filesRoot ?? openGitHub?.root);
  /** The machine has the GitHub calls the rail's GitHub page reads. */
  const githubOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= GITHUB_VERSION;
  /** The machine has the issue calls; an older one has the pull requests alone. */
  const issuesOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= ISSUES_VERSION;
  /** The machine runs automations; an older one has none to show. */
  const automationsOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= AUTOMATIONS_VERSION;
  /** The machine runs GitHub triggers and cross-lab review for automations. */
  const githubAutomationsOk =
    drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= GITHUB_AUTOMATIONS_VERSION;
  /** Opens a pull request or an issue of `root`'s repository in a tab of its own, as files open. */
  const openGitHubIn = (root: string, kind: GitHubKind, number: number, title?: string) => {
    const key = githubKey(root, kind, number);
    if (title !== undefined) nameGitHubTab(registry, key, title);
    showTab(key);
  };
  const githubPanel =
    githubRoot === undefined || !githubOpen || settingsOpen ? undefined : (
      <GitHubPanel
        cwd={githubRoot}
        openPull={openGitHub?.kind === "pr" && openGitHub.root === githubRoot ? openGitHub.number : undefined}
        onOpenPull={(number, title) => openGitHubIn(githubRoot, "pr", number, title)}
        review={selected === undefined ? undefined : { threadId: selected.thread.id, messageBox }}
        {...(issuesOk
          ? {
              issues: (repository) => ({
                content: (
                  <IssuesTab
                    cwd={githubRoot}
                    repository={repository}
                    activeNumber={
                      openGitHub?.kind === "issue" && openGitHub.root === githubRoot
                        ? openGitHub.number
                        : undefined
                    }
                    onOpen={(number, title) => openGitHubIn(githubRoot, "issue", number, title)}
                  />
                ),
                refresh: () => refreshIssueList(registry, githubRoot),
              }),
            }
          : {})}
        onClose={() => closePanel("github")}
      />
    );
  // The artifacts the open thread's lead drew, and its project's, which its machine lists when it can.
  const viewedLead = viewed ? leadOf(viewed.agents) : undefined;
  const artifactsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? artifactEventsAtom(selected.thread.id)
    : cloudEvents;
  const artifactEvents = AsyncResult.getOrElse(
    useAtomValue(artifactsAtom),
    (): ReadonlyArray<AgentEvent> => [],
  );
  const viewedArtifacts = viewedLead ? threadArtifacts(artifactEvents, viewedLead.id) : [];
  const artifactsProject =
    selected && (drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= ARTIFACTS_VERSION)
      ? (selected.thread.worktree?.project ?? selected.thread.cwd)
      : undefined;
  const artifactsAvailable =
    viewed !== undefined && (viewedArtifacts.length > 0 || artifactsProject !== undefined);
  const threadOf = (threadId: string) =>
    overviews.find((overview) => overview.thread.id === threadId)?.thread;
  /** Brings an artifact into view in its conversation, opening that thread first when it isn't open. */
  const showArtifact = (artifact: PanelArtifact) => {
    if (artifact.threadId !== viewed?.thread.id) {
      const summary = summaries.find((candidate) => candidate.id === artifact.threadId);
      // A thread's own window shows no other thread: the main window has them.
      if (summary === undefined || solo) return;
      openSummary(summary);
    }
    // The narrow window shows one pane: the conversation takes the panel's place.
    if (compact) closePanel("artifacts");
    void revealArtifact(artifact.id);
  };

  return {
    filesRoot,
    fileRoots,
    gitRoot,
    openerIn,
    openTurnFile,
    terminal,
    runThreadId,
    runRunning,
    toggleRun,
    setupProject,
    scriptsProject,
    setupRun,
    projectActions,
    refreshProjectScripts,
    toggleAction,
    filesPanel,
    sourceControl,
    githubRoot,
    githubOk,
    issuesOk,
    automationsOk,
    githubAutomationsOk,
    openGitHubIn,
    githubPanel,
    viewedLead,
    viewedArtifacts,
    artifactsProject,
    artifactsAvailable,
    threadOf,
    showArtifact,
  };
}

export type WorkspaceTools = ReturnType<typeof useWorkspaceTools>;
