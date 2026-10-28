import {
  OFFERED_PROVIDERS,
  type AccountState,
  type AccountThreads,
  type AgentEvent,
  type DeviceId,
  type DeviceInfo,
  type AgentId,
  type ThreadId,
  type WorktreeChanges,
} from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import {
  RegistryContext,
  RegistryProvider,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AppWindow,
  ArchiveRestore,
  Bot,
  Columns2,
  ClipboardCopy,
  Compass,
  FileDown,
  FoldVertical,
  FolderTree,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  History,
  MessagesSquare,
  OctagonX,
  PanelLeft,
  Play,
  RotateCcw,
  Rows2,
  ScrollText,
  Search,
  Settings,
  Square,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  accountAtom,
  accountThreadsAtom,
  cloudEventsAtom,
  compactAgent,
  createThread,
  deleteThread,
  editMessage,
  fileChangesAtom,
  harnessesAtom,
  importedThreadsAtom,
  interruptAgent,
  localWorkingAtom,
  manifestsAtom,
  markThreadsRead,
  previewRestore,
  renameThread,
  resolveSpawnApproval,
  restoreBefore,
  respondToPermission,
  steerAgent,
  summaryEventsAtom,
  withdrawMessage,
  answerQuestion,
  sendMessage,
  setThreadArchived,
  setThreadLater,
  stopAgent,
  stopThread,
  switchModel,
  handOffLead,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { refreshIssueList } from "../backend/issues.ts";
import { driveMachine, machineAtom, machineKey, machineToDrive } from "../backend/machine.ts";
import { saveProject, worktreeChanges } from "../backend/projects.ts";
import { runProjectScript } from "../backend/scripts.ts";
import { WEB } from "../backend/target.ts";
import { leadOf, modelLabel, toAgentSummaries, toThreadSummary } from "../backend/view.ts";
import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import {
  UnreachableNotice,
  useAccountPresence,
  useShellPresence,
} from "../features/account/AccountNotice.tsx";
import { MachinePicker } from "../features/account/MachinePicker.tsx";
import { presenceLabel, reachOf } from "../features/account/model.ts";
import { type AgentActions } from "../features/agents/AgentMenu.tsx";
import {
  type AnswerApproval,
  type AnswerQuestion,
  type AnswerSpawn,
} from "../features/agents/ApprovalTray.tsx";
import { Inspector } from "../features/agents/Inspector.tsx";
import { STOP_THREAD_VERSION, stopAllScope } from "../features/agents/model.ts";
import { StopAllDialog } from "../features/agents/StopAllDialog.tsx";
import { ArtifactsPanel } from "../features/artifacts/ArtifactsPanel.tsx";
import {
  ARTIFACTS_VERSION,
  revealArtifact,
  threadArtifacts,
  type PanelArtifact,
} from "../features/artifacts/model.ts";
import type { OutgoingMessage, ThreadSetup } from "../features/composer/Composer.tsx";
import { hasContent } from "../features/composer/draft.ts";
import {
  draftsAtom,
  draftStartAtom,
  isNewDraftKey,
  newDraftKey,
  startedNow,
  withDraft,
  withoutDraft,
  type NewThreadDraft,
} from "../features/composer/drafts.ts";
import type { MessageBox } from "../features/composer/messageBox.ts";
import { HANDOFF_VERSION, useModels } from "../features/composer/models.ts";
import { useLatestProject } from "../features/composer/ProjectPicker.tsx";
import { DraftSync } from "../features/composer/useDraftSync.ts";
import { ScrollArea } from "../components/ui/ScrollArea.tsx";
import { AUTOMATIONS_VERSION } from "../backend/automations.ts";
import {
  AutomationDetail,
  AutomationList,
  AutomationsPage,
} from "../features/automations/AutomationsPage.tsx";
import { TaskSync } from "../features/tasks/TaskSync.ts";
import { TaskDetail, TaskList, TasksPage, type HandOff } from "../features/tasks/TasksPage.tsx";
import { FILES_VERSION, type OpenFile } from "../features/files/model.ts";
import type { PaletteCommand } from "../features/palette/palette.ts";
import { useFilesExplorer } from "../features/files/useFilesExplorer.tsx";
import { GIT_VERSION } from "../features/git/model.ts";
import { useSourceControl } from "../features/git/useSourceControl.tsx";
import { GitHubPanel } from "../features/github/GitHubPanel.tsx";
import { GitHubPageEmpty, GitHubPageList } from "../features/github/GitHubPage.tsx";
import { GitHubTabView } from "../features/github/GitHubTab.tsx";
import {
  GITHUB_VERSION,
  githubKey,
  githubOfKey,
  type GitHubKind,
  type GitHubTab,
} from "../features/github/model.ts";
import { nameGitHubTab } from "../features/github/tabs.ts";
import { IssueViewer } from "../features/issues/IssueViewer.tsx";
import { IssuesTab } from "../features/issues/IssuesTab.tsx";
import { ISSUES_VERSION } from "../features/issues/model.ts";
import { BrowserHost } from "../features/preview/BrowserHost.tsx";
import {
  previewBridge,
  previewStates,
  setLocalOpener,
  subscribePreviews,
} from "../features/preview/model.ts";
import { PreviewPane } from "../features/preview/PreviewPane.tsx";
import { usePreviewDocks } from "../features/preview/usePreviewDocks.ts";
import {
  PROJECT_TERMINAL_VERSION,
  SCRIPT_VERSION,
  TERMINAL_VERSION,
  scriptTerminalOf,
} from "../features/terminal/model.ts";
import { fittedSize } from "../features/terminal/session.ts";
import { closeTerminal, terminalsAtom } from "../backend/terminals.ts";
import { useTerminalDrawer } from "../features/terminal/useTerminalDrawer.tsx";
import { scaleAtom, stepScale, themeAtom } from "../features/settings/preferences.ts";
import { canScale, useScale, useWindowSolid } from "../features/settings/scale.ts";
import {
  settingsLabel,
  SettingsNav,
  settingsPages,
  SettingsView,
  type SettingsCategory,
} from "../features/settings/Settings.tsx";
import { useTheme } from "../features/settings/theme.ts";
import { exportFailureAtom, useThreadExport } from "../features/export/useThreadExport.ts";
import { ThreadTabs } from "../features/tabs/ThreadTabs.tsx";
import { useThreadTabs } from "../features/tabs/useThreadTabs.ts";
import { CloudThreadBar, LoadingThreadBar, NoComputerBar } from "../features/threads/CloudThread.tsx";
import { useReadState } from "../features/threads/readState.ts";
import { ArchiveWorktreeDialog } from "../features/threads/ArchiveWorktree.tsx";
import { LATER_VERSION, type ThreadSummary } from "../features/threads/model.ts";
import { WORKTREE_VERSION } from "../features/threads/worktree.ts";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { THREAD_SEARCH_VERSION } from "../features/threads/threadSearch.ts";
import { openFind } from "../features/transcript/find.ts";
import { EDIT_VERSION, STEER_VERSION, WITHDRAW_VERSION } from "../features/transcript/model.ts";
import { RESTORE_VERSION } from "../features/transcript/restore.ts";
import { revertTurnFiles, TURN_FILES_VERSION } from "../backend/turnFiles.ts";
import { ThreadMark } from "../features/threads/StatusIndicator.tsx";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { whatsNewOpenAtom } from "../features/whatsnew/state.ts";
import { welcomeOpenAtom, welcomeShownAtom } from "../features/onboarding/state.ts";
import { WhatsNewHost } from "../features/whatsnew/WhatsNewHost.tsx";
import { ImportDialogHost } from "../features/imports/ImportDialog.tsx";
import { importOpenAtom } from "../features/imports/state.ts";
import type { DragSource } from "../features/split/drag.ts";
import {
  canSplit,
  closeKeys,
  closePane,
  findPane,
  focusedKey,
  focusPane,
  followShown,
  isSplit,
  layoutOf,
  leavesOf,
  movePane,
  paneShowing,
  renameKey,
  resizeSplit,
  showInPane,
  singlePane,
  splitPane,
  spreadBeside,
  type DropZone,
  type PaneLeaf,
  type Panes,
  type Side,
} from "../features/split/model.ts";
import { MIN_PANE, SplitView, type PaneChrome, type PaneLabel } from "../features/split/SplitView.tsx";
import { FileViewer } from "../features/viewer/FileViewer.tsx";
import {
  commitFileKey,
  commitFileOfKey,
  fileKey,
  fileOfKey,
  fileViewAtom,
  turnFileKey,
  turnFileOfKey,
  VIEWER_VERSION,
  type TurnFileTab,
} from "../features/viewer/model.ts";
import { TurnFileView } from "../features/viewer/TurnFileView.tsx";
import { CommitFileView } from "../features/git/history/CommitFileView.tsx";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { usesCommandKey } from "../lib/keys.ts";
import {
  bindingFor,
  isCapturingBinding,
  isField,
  matchesBinding,
  matchesFamily,
  shortcutBindingsAtom,
  type ShortcutId,
  typesInField,
} from "../lib/shortcuts.ts";
import { remember, stored } from "../lib/storage.ts";
import { useMatchingBuild } from "../web/builds.ts";
import { useDesktopNotifications } from "../desktop/notifications.ts";
import { useNotificationOpens, useRenewPush } from "../web/push.ts";
import { WebGate } from "../web/WebGate.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { useLaunched } from "./launch.ts";
import { Launch } from "./LaunchScreen.tsx";
import { useCompact } from "./compact.ts";
import type { AppMode } from "./mode.ts";
import { BackendFailureNotice, useBackendFailure } from "../features/crash/BackendFailureNotice.tsx";
import { CrashGuard } from "../features/crash/CrashGuard.tsx";
import { PaneCrash } from "../features/crash/CrashViews.tsx";
import { Notice } from "./Notice.tsx";
import type { SidePanelId } from "./panelLayout.ts";
import { Rail } from "./Rail.tsx";
import { freshBlank, rememberSession, restoredSession } from "./session.ts";
import { TextMenu } from "./TextMenu.tsx";
import { ThreadPane, type PaneHandles, type ThreadPaneActions } from "./ThreadPane.tsx";
import { besideThread, soloThread, threadWindowOpener, useSharedPreferences } from "./threadWindow.ts";

const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));
const FOLDER_KEY = "cerium:lastFolder";
const SIDEBAR_KEY = "cerium:sidebar";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong.";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * `run` on each of `items`, one after another, and how each went. A backend action takes one call at
 * a time: a second call made while the first is in flight interrupts it.
 */
const settleInTurn = async <A, B>(
  items: ReadonlyArray<A>,
  run: (item: A) => Promise<B>,
): Promise<ReadonlyArray<PromiseSettledResult<B>>> => {
  const results: Array<PromiseSettledResult<B>> = [];
  for (const item of items) {
    results.push(
      await run(item).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      ),
    );
  }
  return results;
};

/** The window's shortcuts a thread's own window keeps: its zoom, its panels and its thread's. */
const SOLO_SHORTCUTS: ReadonlyArray<ShortcutId> = [
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "toggle-agents",
  "toggle-files",
  "toggle-source-control",
  "toggle-github-panel",
  "find-in-thread",
  "stop-all",
];

/** The main area's pane until the user splits it. */
const MAIN_PANE = "main";
const newPaneId = () => `pane-${crypto.randomUUID()}`;

export function App() {
  return (
    <RegistryProvider>
      <TooltipProvider delay={400}>
        <Themed>
          <Launch>
            <WebGate>
              <Workspace />
            </WebGate>
          </Launch>
        </Themed>
        <TextMenu />
      </TooltipProvider>
    </RegistryProvider>
  );
}

/** Keeps the page on the chosen theme and scale, the web client's sign-in included. */
function Themed({ children }: { children: ReactNode }) {
  useTheme(useAtomValue(themeAtom));
  useScale();
  useWindowSolid();
  useSharedPreferences();
  return children;
}

function Workspace() {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  /** Every shortcut's keys, following the user's rebinds in Settings → Keyboard. */
  const bindings = useAtomValue(shortcutBindingsAtom);
  const keys = (id: ShortcutId): string => bindingFor(bindings, id);
  /** The thread this window shows alone, when it's a thread's own window (threadWindow.ts). */
  const solo = soloThread;
  /** Where this tab was before a reload; it comes back once the window drives the same machine. */
  const [session] = useState(() => (solo ? undefined : restoredSession()));
  // Compared on its own line: the React Compiler skips a component whose ternary tests an optional chain.
  const sameMachine = session?.machine === driven?.id;
  const resumed = sameMachine ? session : undefined;
  const [resumePending, setResumePending] = useState(() => session !== undefined && resumed === undefined);
  const [mode, setMode] = useState<AppMode>(() => solo?.mode ?? session?.mode ?? "work");
  /**
   * The open thread per mode, or the draft of a thread not started yet; none means the mode's blank
   * new thread.
   */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>(() =>
    solo ? { [solo.mode]: solo.id } : (resumed?.open ?? {}),
  );
  /** Each mode's blank new thread: once it has something in it, "New thread" starts another. */
  const [blank, setBlank] = useState(() => resumed?.blank ?? freshBlank());
  /** How each mode's main area is split into panes, once the user split it; the open thread is the focused pane's. */
  const [panesByMode, setPanesByMode] = useState<Partial<Record<AppMode, Panes>>>(() => resumed?.panes ?? {});
  /**
   * The panel beside the conversation: the agents (the inspector), the files, the artifacts, Source
   * control or GitHub, which take that place one at a time.
   */
  const [sidePanel, setSidePanel] = useState<SidePanelId>();
  const inspectorOpen = sidePanel === "agents";
  const filesOpen = sidePanel === "files";
  const artifactsOpen = sidePanel === "artifacts";
  const gitOpen = sidePanel === "git";
  const githubOpen = sidePanel === "github";
  /** Opens `panel` in that place, or closes it when it's the one open. */
  const togglePanel = (panel: SidePanelId) => setSidePanel((open) => (open === panel ? undefined : panel));
  /** Closes `panel`, when it's the one open. */
  const closePanel = (panel: SidePanelId) => setSidePanel((open) => (open === panel ? undefined : open));
  /** The agent the inspector shows; the lead until another is picked. */
  const [inspectedAgent, setInspectedAgent] = useState<string>();
  /** The narrow window's pane: the threads, or the open (or new) thread. */
  const [pane, setPane] = useState<"list" | "main">(() => resumed?.pane ?? "list");
  const folderKey = machineKey(FOLDER_KEY, driven);
  const [folder, setFolder] = useState(() => stored(folderKey));
  // Switching machines starts afresh there: its last folder, and no thread open from the other one.
  const [shownFolderKey, setShownFolderKey] = useState(folderKey);
  /** A thread on another machine the user opened, which opens once the window drives that machine. */
  const [openAfterSwitch, setOpenAfterSwitch] = useState<{ readonly mode: AppMode; readonly id: string }>();
  if (shownFolderKey !== folderKey) {
    const back = resumePending ? resumed : undefined;
    setShownFolderKey(folderKey);
    setFolder(stored(folderKey));
    setOpenThread(openAfterSwitch ? { [openAfterSwitch.mode]: openAfterSwitch.id } : (back?.open ?? {}));
    setBlank(back?.blank ?? freshBlank());
    setPanesByMode(openAfterSwitch ? {} : (back?.panes ?? {}));
    if (back) setPane(back.pane);
    setOpenAfterSwitch(undefined);
    setResumePending(false);
  }
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const [actionError, setActionError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The rail's place besides the threads that shows, if any: the user's tasks, GitHub's items, or the
   * automations.
   */
  const [place, setPlace] = useState<"tasks" | "github" | "automations">();
  /** The automation the Automations page shows beside its list: one saved, or `"new"`. */
  const [automationPick, setAutomationPick] = useState<string>();
  /** The narrow window's Automations pane: the list, or the automation picked in it. */
  const [automationsPane, setAutomationsPane] = useState<"list" | "main">("list");
  /** The task the Tasks page shows beside its list. */
  const [taskPick, setTaskPick] = useState<string>();
  /** The narrow window's Tasks pane: the list, or the task picked in it. */
  const [tasksPane, setTasksPane] = useState<"list" | "main">("list");
  /** The pull request or issue the GitHub page shows. */
  const [githubPick, setGithubPick] = useState<GitHubTab>();
  /** The narrow window's GitHub pane: the list, or what was picked in it. */
  const [githubPane, setGithubPane] = useState<"list" | "main">("list");
  /** Back to the threads, from settings or another of the rail's places. */
  const showThreads = () => {
    setSettingsOpen(false);
    setPlace(undefined);
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const compact = useCompact();
  /** Its settings pane: the categories, or the open category's page. */
  const [settingsPane, setSettingsPane] = useState<"nav" | "page">("nav");
  /** The category settings open on: the last one visited. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  /** Each pane's message box, by the thread it shows; the window reaches the open thread's. */
  const paneHandles = useRef(new Map<string, PaneHandles>());
  /** The open tab, as the window's handlers find it after each render. */
  const openKey = useRef<string>(undefined);
  /** The thread open last, which a file open since still writes to. */
  const lastThread = useRef<string>(undefined);
  const handlesOf = (key: string | undefined) =>
    key === undefined ? undefined : paneHandles.current.get(key);
  /** Puts the cursor in the open thread's message box. */
  const focusComposer = () => handlesOf(openKey.current)?.input.current?.focus();
  /** Puts a comment of the window's into the routed thread's draft, where the tray and the diffs read it. */
  const setDrafts = useAtomSet(draftsAtom);
  const putComment = useEffectEvent((content: Parameters<MessageBox["comment"]>[0]) => {
    const key = lastThread.current ?? openKey.current;
    if (key === undefined) return;
    setDrafts((drafts) =>
      withDraft(drafts, key, (draft) => ({
        ...draft,
        comments: [...(draft.comments ?? []), { id: crypto.randomUUID(), ...content }],
      })),
    );
  });
  /**
   * What the rest of the window puts into the open thread's message box: with a file open, the
   * thread's open before it, else whichever thread shows.
   */
  const [messageBox] = useState((): MessageBox => {
    const box = () =>
      (
        handlesOf(openKey.current) ??
        handlesOf(lastThread.current) ??
        paneHandles.current.values().next().value
      )?.box;
    return {
      mention: (mention) => box()?.mention(mention),
      append: (content) => box()?.append(content),
      comment: (content) => putComment(content),
      key: () => box()?.key(),
    };
  });
  const [onPaneHandles] = useState(() => (key: string, handles: PaneHandles | undefined) => {
    if (handles) paneHandles.current.set(key, handles);
    else paneHandles.current.delete(key);
  });

  const connection = useAtomValue(connectionAtom);
  const backendFailure = useBackendFailure();
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnessesResult = useAtomValue(harnessesAtom);
  const manifests = useAtomValue(manifestsAtom);
  const harnesses = AsyncResult.getOrElse(harnessesResult, () => []);
  const models = useModels();
  // Another machine that can't be reached shows the threads it last listed no more: they read from
  // the cloud copy instead, until it answers again. This computer's own list stays while it reconnects.
  const live =
    AsyncResult.isSuccess(threadsResult) && !(connection === "unreachable" && driven !== undefined);
  const overviews: ReadonlyArray<ThreadOverview> = live
    ? AsyncResult.getOrElse(threadsResult, () => [])
    : driven === undefined
      ? // A list call that fails while the backend restarts keeps the last list it gave.
        Option.getOrElse(AsyncResult.value(threadsResult), () => [])
      : [];
  const accountResult = useAtomValue(accountAtom);
  const account = AsyncResult.getOrElse(accountResult, (): AccountState => ({
    _tag: "SignedOut",
  }));
  const accountThreads = AsyncResult.getOrElse(useAtomValue(accountThreadsAtom), (): AccountThreads => ({
    threads: [],
    read: [],
  }));
  // Every thread of the account: the driven machine's live, the others' from the cloud copy.
  const devices = account._tag === "SignedIn" ? account.devices : [];
  const thisComputer = account._tag === "SignedIn" ? account.deviceId : undefined;
  const drivenId = driven?.id ?? thisComputer;
  const deviceOf = (id: string) => devices.find((device) => device.id === id);
  const nameOf = (id: string) => deviceOf(id)?.name ?? "another computer";
  // Until the driven machine answers, or while it can't, its threads read from the copy too.
  const elsewhere = accountThreads.threads.filter(
    (each) =>
      drivenId !== undefined &&
      (each.machine !== drivenId || !live) &&
      !overviews.some((overview) => overview.thread.id === each.overview.thread.id),
  );
  /** The thread `key` names: live from the driven machine, or another machine's from the cloud copy. */
  const resolve = (key: string | undefined) => {
    const listed = overviews.find((overview) => overview.thread.id === key && overview.thread.mode === mode);
    /** Another machine's thread open from the cloud copy, read-only, while that machine can't be reached. */
    const cloud = listed
      ? undefined
      : elsewhere.find((each) => each.overview.thread.id === key && each.overview.thread.mode === mode);
    const shown = listed ?? cloud?.overview;
    /**
     * The thread isn't listed yet because the list hasn't loaded (just after a reload): it holds
     * its place rather than showing the blank new thread, whose draft the user would be writing in.
     */
    const loading =
      shown === undefined &&
      key !== undefined &&
      !isNewDraftKey(key) &&
      overviews.length === 0 &&
      !AsyncResult.isSuccess(threadsResult);
    return { listed, cloud, shown, loading };
  };
  // A thread's own window is its thread's, whichever of its panes has the focus.
  const { listed: selected, cloud: cloudSelected, shown: viewed } = resolve(solo?.id ?? openThread[mode]);
  /** The thread not started yet the new-thread view shows: one opened from the sidebar, or the blank one. */
  const openDraft = isNewDraftKey(openThread[mode]) ? openThread[mode] : blank[mode];
  const latestProject = useLatestProject();
  /** The folder a new thread starts in, unless its draft chose one: the last one, else the project used most recently. */
  const defaultFolder = folder ?? latestProject;
  /** What the window shows: the open thread, or the draft of one not started yet. */
  const current = openThread[mode] ?? blank[mode];
  const currentStart = useAtomValue(draftStartAtom(current));
  /**
   * The project the work thread not started yet that the window shows would start in: its files,
   * changes, GitHub repository and terminals are there to use before the first message.
   */
  const newProject =
    mode === "work" && isNewDraftKey(current) ? (currentStart?.folder ?? defaultFolder) : undefined;
  // The panes follow whatever the window shows: the focused pane takes it, or the pane showing it takes focus.
  const storedPanes = panesByMode[mode];
  const panes = storedPanes ? followShown(storedPanes, current) : singlePane(MAIN_PANE, current);
  if (storedPanes !== undefined && panes !== storedPanes) {
    setPanesByMode((all) => ({ ...all, [mode]: panes }));
  }
  const split = !compact && isSplit(panes);
  /** The draft the window's message box writes to: the open thread, or the one open last before its file. */
  const [lastThreadKey, setLastThreadKey] = useState<string | undefined>(
    isNonThreadKey(current) ? undefined : current,
  );
  if (!isNonThreadKey(current) && lastThreadKey !== current) setLastThreadKey(current);
  const routedDraftKey = isNonThreadKey(current) ? lastThreadKey : current;
  useLayoutEffect(() => {
    openKey.current = current;
    if (!isNonThreadKey(current)) lastThread.current = current;
  }, [current]);
  /** The file the open tab shows, when it shows one. */
  const openFile = fileOfKey(current);
  /** The folder of the file a commit's tab shows, which is the repository Source control and the files panel show. */
  const openCommitRoot = commitFileOfKey(current)?.root;
  const share = useAtomSet(markThreadsRead, { mode: "promise" });
  const readState = useReadState(
    new Map(accountThreads.read.map((entry) => [entry.threadId as string, entry.seenAt])),
    account._tag === "SignedIn"
      ? (entries) =>
          void share({
            payload: {
              entries: entries.map((entry) => ({ ...entry, threadId: entry.threadId as ThreadId })),
            },
          }).catch(() => undefined)
      : undefined,
  );
  // Threads just brought in from the harnesses arrive with their own past activity, which isn't news.
  const [imported, setImported] = useAtom(importedThreadsAtom);
  const markImported = useEffectEvent(() => {
    readState.markRead(imported);
    setImported([]);
  });
  useEffect(() => {
    if (imported.length > 0) markImported();
  }, [imported]);
  /** The open thread, when it was unread as the user opened it: it keeps its inbox place until they leave. */
  const [heldUnread, setHeldUnread] = useState<string>();
  const here = overviews
    .map(toThreadSummary)
    .map((summary) => (driven ? { ...summary, machine: driven.name } : summary));
  const there = elsewhere.map((each) => {
    const summary = toThreadSummary(each.overview);
    const online = deviceOf(each.machine)?.online === true;
    return {
      ...summary,
      // An offline machine's agents aren't working, whatever they were doing when it went.
      ...(online || summary.status === "failed" ? {} : { status: "idle" as const }),
      ...(each.machine === thisComputer ? {} : { machine: nameOf(each.machine) }),
      elsewhere: { machine: each.machine, online },
    };
  });
  // A work thread is unread once it changed after the user last saw it; the open one is seen as it changes.
  const summaries = [...here, ...there].map((summary) =>
    summary.mode !== "work"
      ? summary
      : summary.id === viewed?.thread.id
        ? { ...summary, unread: summary.id === heldUnread }
        : { ...summary, unread: readState.isUnread(summary.id, summary.updatedAt) },
  );
  const selectedSummary = summaries.find((summary) => summary.id === viewed?.thread.id);
  /**
   * Opens one of this computer's threads in a window of its own (threadWindow.ts): offered by the
   * desktop's main window while it shows this computer.
   */
  const threadWindow = driven === undefined ? threadWindowOpener() : undefined;
  const openInWindow =
    threadWindow === undefined
      ? undefined
      : (threadId: string) => {
          const summary = summaries.find((each) => each.id === threadId && each.elsewhere === undefined);
          if (summary) threadWindow(summary.id, summary.mode);
        };
  // The shell keeps this computer awake for its own agents, whichever machine the window shows.
  const localWorking = AsyncResult.getOrElse(useAtomValue(localWorkingAtom), () => undefined);
  useShellPresence(
    account,
    driven === undefined
      ? summaries.some((summary) => summary.status === "running")
      : (localWorking ?? false),
  );
  const drivenDevice =
    driven === undefined || account._tag !== "SignedIn"
      ? undefined
      : account.devices.find((device) => device.id === driven.id);
  // The web client runs the build of the desktop it drives, and takes the open thread there.
  useMatchingBuild(
    drivenDevice,
    isNewDraftKey(openThread[mode]) || isNonThreadKey(openThread[mode]) ? undefined : openThread[mode],
  );
  // The web client always drives one of the account's desktops: the one it drove last,
  // else the first that can be reached, once one can.
  const reachable = devices.filter(
    (device) => device.kind === "desktop" && reachOf(device).kind === "reachable",
  );
  const toDrive = WEB && driven === undefined ? machineToDrive(reachable) : undefined;
  const driveChosen = useEffectEvent(() => {
    if (toDrive !== undefined) driveMachine(registry, toDrive);
  });
  useEffect(() => driveChosen(), [toDrive?.id]);
  // The window shows once it has its threads, or has no machine to list them from yet; one that
  // can't be reached shows its notice instead.
  useLaunched(
    connection === "unreachable" ||
      (AsyncResult.isSuccess(accountResult) &&
        (AsyncResult.isSuccess(threadsResult) || (WEB && driven === undefined && toDrive === undefined))),
  );
  // A thread's own window closes once its thread is gone, deleted from here or from the main window.
  const soloGone =
    solo !== undefined && live && !overviews.some((overview) => overview.thread.id === solo.id);
  useEffect(() => {
    if (soloGone) window.close();
  }, [soloGone]);
  const markSeen = useEffectEvent(() => {
    if (selectedSummary && readState.isUnread(selectedSummary.id, selectedSummary.updatedAt)) {
      readState.markRead([selectedSummary]);
    }
  });
  useEffect(() => markSeen(), [selectedSummary?.id, selectedSummary?.updatedAt]);
  // What the window reads of the open thread's events: live from the driven machine, or the cloud
  // copy of another machine's. Only the kinds its agents and artifacts are worked out from, and the
  // files changed while the files panel lists them: its pane renders the conversation, and the window
  // doesn't render again for every tool call or streamed word.
  const cloudEvents = cloudSelected
    ? cloudEventsAtom(`${cloudSelected.machine}:${cloudSelected.overview.thread.id}`)
    : noEvents;
  const eventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? summaryEventsAtom(selected.thread.id)
    : cloudEvents;
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const fileEventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? filesOpen
      ? fileChangesAtom(selected.thread.id)
      : noEvents
    : cloudEvents;
  const fileEvents = AsyncResult.getOrElse(useAtomValue(fileEventsAtom), (): ReadonlyArray<AgentEvent> => []);
  /** Opens another machine's thread there: the window drives that machine, then shows it. */
  const openOn = (device: DeviceInfo, threadId: string, threadMode: AppMode = mode) => {
    setOpenAfterSwitch({ mode: threadMode, id: threadId });
    setPane("main");
    driveMachine(registry, device.id === thisComputer ? undefined : { id: device.id, name: device.name });
  };
  /** Opens a thread of the inbox: another machine's there when it can, else here (read-only when it's another's). */
  const openSummary = (summary: ThreadSummary) => {
    showThreads();
    setHeldUnread(summary.unread ? summary.id : undefined);
    const home = summary.elsewhere ? deviceOf(summary.elsewhere.machine) : undefined;
    if (home && home.id !== drivenId && (home.id === thisComputer || reachOf(home).kind === "reachable")) {
      openOn(home, summary.id, summary.mode);
      return;
    }
    setOpenThread((current) => ({ ...current, [summary.mode]: summary.id }));
    setPane("main");
  };
  const tabs = useThreadTabs({
    machine: driven?.id ?? "local",
    mode,
    active: current,
    threads: summaries,
    loaded: live,
    initial: session?.tabs,
    onShow: (key) => {
      if (!isNewDraftKey(key) && !isNonThreadKey(key)) {
        const summary = summaries.find((candidate) => candidate.id === key);
        if (summary) openSummary(summary);
        return;
      }
      showThreads();
      setOpenThread((current) => ({ ...current, [mode]: key }));
      setPane("main");
    },
    onFresh: (key) => {
      showThreads();
      setBlank((current) => ({ ...current, [mode]: key }));
      setOpenThread((current) => ({ ...current, [mode]: undefined }));
      setPane("main");
      focusComposer();
    },
    // A closed tab's new thread that has nothing in it is forgotten, with what was picked in it.
    onClosed: (keys) => {
      const drafts = registry.get(draftsAtom);
      const empty = keys.filter((key) => isNewDraftKey(key) && !hasContent(drafts[key]));
      if (empty.length > 0) registry.set(draftsAtom, empty.reduce(withoutDraft, drafts));
      // A closed tab's pane closes with it, and the pane that takes its room shows in its place.
      if (!isSplit(panes)) return undefined;
      const left = closeKeys(panes, keys);
      if (left === undefined) return undefined;
      setPanesByMode((all) => ({ ...all, [mode]: left }));
      return keys.includes(current) ? focusedKey(left) : undefined;
    },
  });
  useEffect(() => {
    // A thread's own window comes back to its thread from its address.
    if (resumePending || solo) return;
    rememberSession({
      ...(driven ? { machine: driven.id } : {}),
      mode,
      open: openThread,
      blank,
      pane,
      tabs: tabs.strips,
      panes: panesByMode,
    });
  }, [resumePending, solo, driven, mode, openThread, blank, pane, tabs.strips, panesByMode]);

  // A tapped notification opens its thread, once the inbox lists it.
  useNotificationOpens(
    (threadId) => summaries.find((summary) => summary.id === threadId),
    (summary) => {
      showThreads();
      setMode(summary.mode);
      openSummary(summary);
    },
  );
  useRenewPush(account);
  const threadShown = viewed !== undefined && !settingsOpen && (!compact || pane === "main");
  // Nobody is told about the thread this window shows, unless settings or the narrow
  // window's inbox cover it. The account hears it from the main window alone, whose word a thread's
  // own window would otherwise take turns with; the shell likewise takes the main window's presence
  // and notifications only.
  useAccountPresence(
    solo ? { _tag: "SignedOut" } : account,
    viewed && threadShown && drivenId !== undefined
      ? {
          machine: (cloudSelected?.machine ?? drivenId) as DeviceId,
          threadId: viewed.thread.id,
        }
      : undefined,
  );
  // This computer's own notifications, about any of its threads but the one shown here.
  useDesktopNotifications(
    viewed && threadShown && (cloudSelected ? cloudSelected.machine === thisComputer : driven === undefined)
      ? viewed.thread.id
      : undefined,
  );

  const openWhatsNew = useAtomSet(whatsNewOpenAtom);
  const openImport = useAtomSet(importOpenAtom);
  const openWelcome = useAtomSet(welcomeOpenAtom);
  const create = useAtomSet(createThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const edit = useAtomSet(editMessage, { mode: "promise" });
  const checkRestore = useAtomSet(previewRestore, { mode: "promise" });
  const restore = useAtomSet(restoreBefore, { mode: "promise" });
  const revertTurn = useAtomSet(revertTurnFiles, { mode: "promise" });
  const switchLead = useAtomSet(switchModel, { mode: "promise" });
  const compactLead = useAtomSet(compactAgent, { mode: "promise" });
  const handOffTo = useAtomSet(handOffLead, { mode: "promise" });
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
  const answer = useAtomSet(answerQuestion, { mode: "promise" });
  const resolveSpawn = useAtomSet(resolveSpawnApproval, { mode: "promise" });
  const interrupt = useAtomSet(interruptAgent, { mode: "promise" });
  const steer = useAtomSet(steerAgent, { mode: "promise" });
  const withdraw = useAtomSet(withdrawMessage, { mode: "promise" });
  const stop = useAtomSet(stopAgent, { mode: "promise" });
  const stopEverything = useAtomSet(stopThread, { mode: "promise" });
  /** Waiting on the user to confirm stopping every agent in the open thread. */
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const rename = useAtomSet(renameThread, { mode: "promise" });
  const setArchived = useAtomSet(setThreadArchived, { mode: "promise" });
  const putOff = useAtomSet(setThreadLater, { mode: "promise" });
  const remove = useAtomSet(deleteThread, { mode: "promise" });
  const save = useAtomSet(saveProject, { mode: "promise" });
  /** Runs a backend action, reporting a failure in the notice bar; resolves whether it worked. */
  const changesOf = useAtomSet(worktreeChanges, { mode: "promise" });
  /** A thread whose worktree holds unmerged work, waiting on the user to confirm archiving it. */
  const [archiving, setArchiving] = useState<{ thread: ThreadSummary; changes: WorktreeChanges }>();

  const exportThread = useThreadExport();
  const exportFailure = useAtomValue(exportFailureAtom);
  const setExportFailure = useAtomSet(exportFailureAtom);

  const attempt = (action: Promise<unknown>): Promise<boolean> => {
    setActionError(undefined);
    return action.then(
      () => true,
      (error: unknown) => {
        setActionError(messageOf(error));
        return false;
      },
    );
  };

  /**
   * Archives a thread and closes its tab; resolves whether it went.
   * `discardWork` once the user confirmed losing its worktree's work.
   */
  const archive = (threadId: string, discardWork = false): Promise<boolean> =>
    attempt(
      setArchived({
        payload: { threadId: threadId as ThreadId, archived: true, ...(discardWork ? { discardWork } : {}) },
      }),
    ).then((archived) => {
      if (!archived) return false;
      refreshThreads();
      tabs.drop(threadId);
      return true;
    });

  const indicators: ReadonlyArray<HarnessIndicator> = OFFERED_PROVIDERS.map((provider) => {
    const status = harnesses.find((candidate) => candidate.provider === provider);
    if (status === undefined) return { provider, state: "unsupported" };
    if (status._tag === "HarnessMissing") return { provider, state: "missing" };
    if (status.auth._tag === "LoggedOut") return { provider, state: "loggedOut" };
    return { provider, state: "ready", ...(status.setup ? { needsSetup: true } : {}) };
  });
  const available = new Set(
    indicators.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])),
  );
  /** The harnesses have answered and none can run a thread: there is nothing to start one with. */
  const noHarness = AsyncResult.isSuccess(harnessesResult) && available.size === 0;

  const agents = viewed ? toAgentSummaries(viewed.agents, events, models) : [];
  /** What stopping everything in the open thread would end; offered for a live thread whose machine can. */
  const stopScope = stopAllScope(agents);
  const canStopAll =
    selected !== undefined &&
    cloudSelected === undefined &&
    (drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= STOP_THREAD_VERSION) &&
    (stopScope.agents > 0 || stopScope.approvals > 0);
  const askStopAll = () => {
    if (canStopAll) setStopAllOpen(true);
  };
  const toggleInspector = () => togglePanel("agents");
  const toggleFiles = () => togglePanel("files");
  const toggleGit = () => togglePanel("git");
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
  /** New threads there can have worktrees of their own. */
  const worktreesOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= WORKTREE_VERSION;
  /**
   * Shows the file, pull request or new thread `key` in a tab of its own, beside the thread. A preview
   * would take the thread's tab while that thread is only being read. A thread's own window has no
   * tabs: it shows there in a pane beside the thread.
   */
  const showTab = (key: string) => {
    if (solo) {
      const next = besideThread(panes, solo.id, key, newPaneId());
      setPanesByMode((all) => ({ ...all, [mode]: next }));
      setOpenThread((open) => ({ ...open, [mode]: focusedKey(next) }));
      return;
    }
    tabs.openAs(key, "tab");
    tabs.keep(key);
    showThreads();
    setOpenThread((open) => ({ ...open, [mode]: key }));
    setPane("main");
    // The narrow window shows one pane: the tab takes the panel's place.
    if (compact) setSidePanel(undefined);
  };
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
  const toggleGitHub = () => togglePanel("github");
  /** Opens a pull request or an issue of `root`'s repository in a tab of its own, as files open. */
  const openGitHubIn = (root: string, kind: GitHubKind, number: number, title?: string) => {
    const key = githubKey(root, kind, number);
    if (title !== undefined) nameGitHubTab(registry, key, title);
    showTab(key);
  };
  /** The project a folder is, or is a worktree of: where a thread about its repository starts. */
  const projectOf = (folder: string) =>
    overviews.find((overview) => overview.thread.cwd === folder)?.thread.worktree?.project ?? folder;
  /**
   * Starts a work thread that looks into a pull request or an issue: a new thread in the folder's
   * project with the brief in its message box, for the user to pick the model and send.
   */
  const startThreadFrom = ({
    folder,
    text,
    worktree,
  }: {
    /** None leaves the project to the message box's own choice. */
    folder: string | undefined;
    text: string;
    /** Runs in a worktree of its own; left to the message box's own choice when absent. */
    worktree?: boolean;
  }) => {
    const key = newDraftKey();
    registry.set(
      draftsAtom,
      withDraft(registry.get(draftsAtom), key, () => ({
        segments: [{ kind: "text", text }],
        attachments: [],
        start: startedNow({
          mode: "work",
          ...(folder === undefined ? {} : { folder: projectOf(folder) }),
          ...(driven ? { machine: driven.id } : {}),
          ...(worktree === undefined || !worktreesOk ? {} : { worktree }),
        }),
      })),
    );
    if (solo) {
      showTab(key);
      focusComposer();
      return;
    }
    showThreads();
    setMode("work");
    tabs.openAs(key, "tab");
    setOpenThread((open) => ({ ...open, work: key }));
    setPane("main");
    if (compact) setSidePanel(undefined);
    focusComposer();
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
  const viewedArtifacts = viewedLead ? threadArtifacts(events, viewedLead.id) : [];
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
  const agentActions: AgentActions = {
    onShow: (agentId) => {
      setInspectedAgent(agentId);
      setSidePanel("agents");
    },
    onMessageLead: () => focusComposer(),
    onInterrupt: (agentId) => void attempt(interrupt({ payload: { agentId: agentId as AgentId } })),
    onStop: (agentId) => void attempt(stop({ payload: { agentId: agentId as AgentId } })),
  };
  const answerApproval: AnswerApproval = (agentId, requestId, decision, scope) =>
    void attempt(respond({ payload: { agentId: agentId as AgentId, requestId, decision, scope } }));
  const answerSpawn: AnswerSpawn = (requestId, decision) =>
    void attempt(resolveSpawn({ payload: { requestId, decision } }));
  const answerQuestionOf: AnswerQuestion = (agentId, requestId, response) =>
    attempt(answer({ payload: { agentId: agentId as AgentId, requestId, response } }));
  /**
   * Opens a blank new thread in this mode, ready to type the first message: in a tab of its own, unless
   * a tab already holds an empty one. One the user wrote in stays in the sidebar as a draft.
   */
  const startNew = () => {
    showThreads();
    tabs.newTab();
    focusComposer();
  };

  /** Opens a thread not started yet, on the machine it starts on. */
  const openNewDraft = (draft: NewThreadDraft) => {
    showThreads();
    setPane("main");
    const home = draft.machine === thisComputer ? undefined : draft.machine;
    if (home !== driven?.id) {
      setOpenAfterSwitch({ mode: draft.mode, id: draft.key });
      driveMachine(registry, home === undefined ? undefined : { id: home as DeviceId, name: nameOf(home) });
      return;
    }
    setOpenThread((current) => ({ ...current, [draft.mode]: draft.key }));
  };

  /** Throws a draft away, and its tab with it. */
  const discardDraft = (key: string) => {
    const drafts = registry.get(draftsAtom);
    for (const attachment of drafts[key]?.attachments ?? []) {
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    }
    registry.set(draftsAtom, withoutDraft(drafts, key));
    tabs.drop(key);
  };

  /** The user asked for a new thread: in the narrow window, that's its pane. */
  const newThread = () => {
    startNew();
    setPane("main");
  };

  const openSettings = (category?: SettingsCategory) => {
    if (category) setSettingsCategory(category);
    setSettingsPane(category ? "page" : "nav");
    setSettingsOpen(true);
  };
  // Back from settings or the welcome, the cursor returns to the message box; a phone's keyboard stays down.
  const welcoming = useAtomValue(welcomeShownAtom);
  useEffect(() => {
    if (!settingsOpen && !compact && !welcoming) focusComposer();
  }, [settingsOpen, compact, welcoming]);

  const chooseFolder = (picked: string) => {
    setFolder(picked);
    remember(folderKey, picked);
  };

  /**
   * Lays the panes out as `next` and shows the focused pane's thread. The thread the focused pane
   * showed before stays in a tab of its own, so no later preview takes its tab while it shows.
   */
  const applyPanes = (next: Panes) => {
    setPanesByMode((all) => ({ ...all, [mode]: next }));
    const shown = focusedKey(next);
    if (shown === current) return;
    tabs.keep(current);
    tabs.openAs(shown, "tab");
    showThreads();
    setOpenThread((open) => ({ ...open, [mode]: shown }));
    setPane("main");
  };
  /** Asks for the cursor in the focused pane's message box, once it has rendered. */
  const [composerFocus, setComposerFocus] = useState(0);
  useEffect(() => {
    if (composerFocus > 0) focusComposer();
  }, [composerFocus]);
  /** The room the panes have, in pixels, which a split needs enough of. */
  const panesArea = useRef<HTMLDivElement>(null);
  const paneSize = (id: string) => {
    const box = layoutOf(panes.root).panes.find(({ leaf }) => leaf.id === id)?.box;
    const rect = panesArea.current?.getBoundingClientRect();
    return box === undefined || rect === undefined
      ? { width: 0, height: 0 }
      : { width: box.width * rect.width, height: box.height * rect.height };
  };
  /** Opens the tab `key` on `side` of the pane `target`, when it has the room. */
  const splitWith = (target: string, side: Side, key: string) => {
    if (compact || !canSplit(paneSize(target), side, MIN_PANE)) return false;
    applyPanes(splitPane(panes, target, side, key, newPaneId()));
    return true;
  };
  /** A new thread on `side` of the pane `target`, ready to write in. */
  const splitNew = (target: string, side: Side) => {
    if (splitWith(target, side, newDraftKey())) setComposerFocus((count) => count + 1);
  };
  const closePaneOf = (id: string) => {
    // A thread's own window keeps its thread: closing the window is how it goes.
    if (solo && findPane(panes.root, id)?.key === solo.id) return;
    const left = closePane(panes, id);
    if (left !== undefined) applyPanes(left);
  };
  const focusOn = (id: string) => {
    if (id !== panes.focused) applyPanes(focusPane(panes, id));
  };
  const canDrop = (
    source: DragSource,
    target: string,
    zone: DropZone,
    size: { readonly width: number; readonly height: number },
  ) => {
    const leaf = findPane(panes.root, target);
    if (leaf === undefined) return false;
    if (zone !== "center" && !canSplit(size, zone, MIN_PANE)) return false;
    if (source.kind === "pane") return source.id !== target && isSplit(panes);
    return leaf.key !== source.key;
  };
  const dropOn = (source: DragSource, target: string, zone: DropZone) => {
    if (source.kind === "pane") {
      applyPanes(movePane(panes, source.id, target, zone));
      return;
    }
    const showing = paneShowing(panes.root, source.key);
    if (zone !== "center") applyPanes(splitPane(panes, target, zone, source.key, newPaneId()));
    // Dropped on a pane, a tab shown elsewhere trades places with what it showed.
    else if (showing !== undefined) applyPanes(movePane(panes, showing.id, target, "center"));
    else applyPanes(showInPane(panes, target, source.key));
  };

  const toggleSidebar = () => {
    remember(SIDEBAR_KEY, sidebarOpen ? "hidden" : "shown");
    setSidebarOpen(!sidebarOpen);
  };

  /**
   * The open thread's browser, docked in its pane beside the conversation: the desktop app's own
   * threads each have one, which the user browses and the thread's agents drive (features/preview).
   */
  const previews = useSyncExternalStore(subscribePreviews, previewStates);
  const previewDocks = usePreviewDocks();
  // The shell lays the pages over the main window alone.
  const previewsHere = previewBridge() !== undefined && driven === undefined && !solo;
  const previewThread = previewsHere && selected !== undefined ? selected.thread.id : undefined;
  const previewOpen = previewThread !== undefined && previewDocks.isOpen(previewThread);
  const togglePreview = () => {
    if (previewThread === undefined) return;
    if (previewOpen) previewDocks.hide(previewThread);
    else previewDocks.show(previewThread);
  };
  // A local address a terminal links or prints opens in the open thread's preview.
  const openLink = useEffectEvent((url: string) => {
    if (previewThread === undefined) return;
    void previewBridge()?.navigate(previewThread, url);
    previewDocks.show(previewThread);
  });
  const linksOpen = previewThread !== undefined;
  useEffect(() => {
    if (!linksOpen) return;
    setLocalOpener(openLink);
    return () => setLocalOpener(undefined);
  }, [linksOpen]);
  /** An agent opened a page: its thread's preview shows, there or whenever the thread next does. */
  const agentOpened = (threadId: string) => previewDocks.show(threadId);

  /**
   * What the command palette (Ctrl K) runs besides opening a thread. To offer a new action, add an entry
   * to the "Actions" below: `keys` shows the shortcut it already has, `when` hides it while it can't run.
   */
  // The palette's actions the message box's `/` list offers too: each is named once here, and both
  // lists share it, so the two stay the same action.
  const newThreadCommand: PaletteCommand = {
    id: "new-thread",
    group: "Actions",
    label: mode === "work" ? "New thread" : "New chat",
    icon: SquarePen,
    keys: keys("new-thread"),
    run: newThread,
  };
  const findCommand: PaletteCommand = {
    // The focused pane's thread finds the text: the files panel, when it has focus, finds files instead.
    id: "find-in-thread",
    group: "Actions",
    label: "Find in thread",
    icon: Search,
    keys: keys("find-in-thread"),
    keywords: "search messages transcript",
    when: selected !== undefined,
    run: openFind,
  };
  const compactCommand: PaletteCommand = {
    // The open thread's lead, between turns, where its harness compacts when asked.
    id: "compact",
    group: "Actions",
    label: "Compact conversation",
    icon: FoldVertical,
    keywords: "context summarize tokens",
    when:
      viewedLead !== undefined &&
      cloudSelected === undefined &&
      viewedLead.state === "idle" &&
      AsyncResult.isSuccess(manifests) &&
      manifests.value.some(
        (manifest) => manifest.provider === viewedLead.provider && manifest.compact === true,
      ),
    run: () => {
      if (viewedLead) void attempt(compactLead({ payload: { agentId: viewedLead.id } }));
    },
  };
  const settingsCommand: PaletteCommand = {
    id: "settings",
    group: "Actions",
    label: "Open settings",
    icon: Settings,
    keys: keys("open-settings"),
    run: () => openSettings(),
  };
  const paletteCommands: ReadonlyArray<PaletteCommand> = [
    newThreadCommand,
    {
      id: "sidebar",
      group: "Actions",
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: PanelLeft,
      keys: keys("toggle-sidebar"),
      run: toggleSidebar,
    },
    {
      id: "agents",
      group: "Actions",
      label: inspectorOpen ? "Hide agents" : "Show agents",
      icon: Bot,
      keys: keys("toggle-agents"),
      keywords: "inspector",
      when: selected !== undefined,
      run: toggleInspector,
    },
    findCommand,
    compactCommand,
    {
      id: "export-markdown",
      group: "Actions",
      label: "Export as Markdown…",
      icon: FileDown,
      keywords: "save download file thread conversation",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "markdown");
      },
    },
    {
      id: "export-text",
      group: "Actions",
      label: "Export as text…",
      icon: FileDown,
      keywords: "save download file thread conversation plain",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "text");
      },
    },
    {
      id: "copy-markdown",
      group: "Actions",
      label: "Copy as Markdown",
      icon: ClipboardCopy,
      keywords: "clipboard thread conversation",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "copy");
      },
    },
    {
      id: "stop-all",
      group: "Actions",
      label: "Stop everything",
      icon: OctagonX,
      keys: keys("stop-all"),
      keywords: "interrupt cancel halt agents deny approvals",
      when: canStopAll,
      run: askStopAll,
    },
    {
      id: "files",
      group: "Actions",
      label: filesOpen ? "Hide files" : "Show files",
      icon: FolderTree,
      keys: keys("toggle-files"),
      when: filesRoot !== undefined,
      run: toggleFiles,
    },
    {
      id: "source-control",
      group: "Actions",
      label: gitOpen ? "Hide source control" : "Show source control",
      icon: GitBranch,
      keys: keys("toggle-source-control"),
      keywords: "git changes stage commit",
      when: gitRoot !== undefined,
      run: toggleGit,
    },
    {
      id: "github",
      group: "Actions",
      label: githubOpen ? "Hide GitHub" : "Show GitHub",
      icon: GitPullRequestArrow,
      keys: keys("toggle-github-panel"),
      keywords: "pull requests prs issues reviews",
      when: githubRoot !== undefined,
      run: toggleGitHub,
    },
    {
      id: "terminal",
      group: "Actions",
      label: terminal.open ? "Hide terminal" : "Show terminal",
      icon: SquareTerminal,
      keys: keys("toggle-terminal"),
      when: terminal.available,
      run: terminal.toggle,
    },
    {
      id: "run-project",
      group: "Actions",
      label: runRunning ? "Stop project run" : "Run project",
      icon: runRunning ? Square : Play,
      keywords: "dev server start localhost stop",
      when: runThreadId !== undefined,
      run: toggleRun,
    },
    {
      // The project's setup command: what makes the thread's folder (or its new worktree) usable.
      id: "setup-project",
      group: "Actions",
      label: "Setup project",
      icon: Wrench,
      keywords: "install dependencies npm bun pnpm build",
      when: runThreadId !== undefined,
      run: setupProject,
    },
    {
      id: "preview",
      group: "Actions",
      label: previewOpen ? "Hide preview" : "Show preview",
      icon: Globe,
      keywords: "browser web page localhost dev server",
      when: previewThread !== undefined,
      run: togglePreview,
    },
    {
      id: "mode",
      group: "Actions",
      label: mode === "work" ? "Switch to Chat" : "Switch to Work",
      icon: MessagesSquare,
      keys: keys(mode === "work" ? "switch-to-chat" : "switch-to-work"),
      run: () => {
        showThreads();
        setMode(mode === "work" ? "chat" : "work");
      },
    },
    {
      id: "split-right",
      group: "Actions",
      label: "Split right",
      icon: Columns2,
      keys: keys("split-right"),
      keywords: "new thread beside pane",
      when: !compact,
      run: () => splitNew(panes.focused, "right"),
    },
    {
      id: "split-below",
      group: "Actions",
      label: "Split below",
      icon: Rows2,
      keys: keys("split-below"),
      keywords: "new thread pane",
      when: !compact,
      run: () => splitNew(panes.focused, "bottom"),
    },
    {
      id: "close-tab",
      group: "Actions",
      label: "Close tab",
      icon: X,
      keys: keys("close-tab"),
      when: !compact,
      run: tabs.closeActive,
    },
    {
      id: "reopen-tab",
      group: "Actions",
      label: "Reopen closed tab",
      icon: RotateCcw,
      keys: keys("reopen-tab"),
      when: !compact,
      run: tabs.reopen,
    },
    {
      // The open thread on a window of its own, to keep beside this one or on another screen.
      id: "open-window",
      group: "Actions",
      label: "Open in new window",
      icon: AppWindow,
      keywords: "pop out detach separate second monitor screen",
      when: openInWindow !== undefined && selected !== undefined,
      run: () => {
        if (selected) openInWindow?.(selected.thread.id);
      },
    },
    {
      // An archived thread, a chat most of all, is found through the palette, and brought back here.
      id: "restore-thread",
      group: "Actions",
      label: "Restore from archive",
      icon: ArchiveRestore,
      keywords: "unarchive archived",
      when: selectedSummary?.archivedAt !== undefined,
      run: () => {
        if (selectedSummary === undefined) return;
        void attempt(
          setArchived({ payload: { threadId: selectedSummary.id as ThreadId, archived: false } }),
        ).then((restored) => {
          if (restored) refreshThreads();
        });
      },
    },
    settingsCommand,
    {
      id: "whats-new",
      group: "Actions",
      label: "What's new",
      icon: ScrollText,
      keywords: "changelog release notes updates",
      run: () => openWhatsNew(true),
    },
    {
      id: "welcome",
      group: "Actions",
      label: "Welcome tour",
      icon: Compass,
      keywords: "onboarding introduction hello start themes harnesses",
      // The web client opens no welcome: it signs in to a desktop that had one.
      when: !WEB,
      run: () => openWelcome(true),
    },
    {
      id: "import-sessions",
      group: "Actions",
      label: "Import sessions…",
      icon: History,
      keywords: "bring sessions claude code codex opencode muse history resume",
      run: () => openImport(true),
    },
    ...settingsPages.map(({ id, label, icon, group }): PaletteCommand => ({
      id: `settings-${id}`,
      group: "Settings",
      label,
      icon,
      keywords: `settings ${group.toLowerCase()}`,
      run: () => openSettings(id),
    })),
  ];

  /**
   * The palette's actions the message box's `/` list offers: new thread, find in thread, compacting
   * and settings. Each keeps its own `when`, so the list shows what runs here.
   */
  const slashCommands: ReadonlyArray<PaletteCommand> = [
    newThreadCommand,
    findCommand,
    compactCommand,
    settingsCommand,
  ];

  /**
   * The keys that step through and move the tabs. Control stays the Control key itself, as browsers
   * have it (a Mac's too, whose ⌘Tab switches apps); whether `event` was one.
   */
  const tabStepShortcut = (event: KeyboardEvent) => {
    const mac = usesCommandKey();
    if (matchesBinding(event, keys("next-tab"), mac)) tabs.step(1);
    else if (matchesBinding(event, keys("previous-tab"), mac)) tabs.step(-1);
    else if (matchesBinding(event, keys("move-tab-right"), mac)) tabs.shift(1);
    else if (matchesBinding(event, keys("move-tab-left"), mac)) tabs.shift(-1);
    else if (
      (event.key === "PageDown" || event.key === "PageUp") &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      // PageUp/PageDown with Control step even where the move bindings went elsewhere.
      const by = event.key === "PageDown" ? 1 : -1;
      if (event.shiftKey) tabs.shift(by);
      else tabs.step(by);
    } else return false;
    return true;
  };

  /** New, closed and closing tabs; whether `event` was one. */
  const tabShortcut = (event: KeyboardEvent) => {
    const mac = usesCommandKey();
    if (matchesBinding(event, keys("new-tab"), mac)) newThread();
    else if (matchesBinding(event, keys("reopen-tab"), mac)) tabs.reopen();
    else if (matchesBinding(event, keys("close-tab"), mac)) tabs.closeActive();
    else return false;
    return true;
  };

  // The shortcuts the window's buttons advertise in their tooltips, each following its rebind.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    // Settings → Keyboard is listening for a rebind: the press being learned must not also run.
    if (isCapturingBinding()) return;
    const mac = usesCommandKey();
    // A thread's own window takes its thread's keys alone, with no tabs, sidebar, places or
    // settings of its own; closing a tab closes the window.
    if (solo) {
      if (matchesBinding(event, keys("close-tab"), mac)) {
        event.preventDefault();
        window.close();
        return;
      }
      if (!SOLO_SHORTCUTS.some((id) => matchesBinding(event, keys(id), mac))) return;
    }
    // Esc backs out of settings, unless something inside them (an open menu) already used it.
    if (event.key === "Escape" && settingsOpen && !event.defaultPrevented) {
      setSettingsOpen(false);
      return;
    }
    // The go-to-tab binding's digit goes to a tab, as the open-thread-row binding opens a sidebar row.
    if (matchesFamily(event, keys("go-to-tab"), mac)) {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined || settingsOpen || searchOpen || compact) return;
      // A Mac's Option layer types with these keys (⌥3 is `#` on a British layout), and in a field
      // the character wins.
      if (typesInField(event, isField(event.target))) return;
      tabs.goTo(Number(digit));
      event.preventDefault();
      return;
    }
    const control = event.ctrlKey && !event.metaKey && !event.altKey;
    if (control && !searchOpen && !settingsOpen && !compact && tabStepShortcut(event)) {
      event.preventDefault();
      return;
    }
    // The zoom bindings scale the desktop window wherever focus is; a browser zooms the page itself.
    if (canScale()) {
      const scaling = matchesBinding(event, keys("zoom-in"), mac)
        ? 1
        : matchesBinding(event, keys("zoom-out"), mac)
          ? -1
          : matchesBinding(event, keys("zoom-reset"), mac)
            ? "reset"
            : undefined;
      if (scaling !== undefined) {
        registry.set(scaleAtom, scaling === "reset" ? 100 : stepScale(registry.get(scaleAtom), scaling));
        event.preventDefault();
        return;
      }
    }
    // Search has the keys while it's open, but for the palette's own binding, which closes it.
    if (searchOpen && !matchesBinding(event, keys("command-palette"), mac)) return;
    if (!settingsOpen && !compact && tabShortcut(event)) {
      event.preventDefault();
      return;
    }
    // The split bindings open a new thread beside the focused pane, below with the below binding.
    if (!settingsOpen && !compact && matchesBinding(event, keys("split-right"), mac)) {
      splitNew(panes.focused, "right");
      event.preventDefault();
      return;
    }
    if (!settingsOpen && !compact && matchesBinding(event, keys("split-below"), mac)) {
      splitNew(panes.focused, "bottom");
      event.preventDefault();
      return;
    }
    if (matchesBinding(event, keys("switch-to-work"), mac)) {
      showThreads();
      setMode("work");
    } else if (matchesBinding(event, keys("switch-to-chat"), mac)) {
      showThreads();
      setMode("chat");
    } else if (matchesBinding(event, keys("open-tasks"), mac)) {
      setSettingsOpen(false);
      setPlace("tasks");
    } else if (matchesBinding(event, keys("open-github"), mac) && githubOk) {
      setSettingsOpen(false);
      setPlace("github");
    } else if (matchesBinding(event, keys("open-automations"), mac) && automationsOk) {
      setSettingsOpen(false);
      setPlace("automations");
    } else if (!settingsOpen && matchesBinding(event, keys("toggle-files"), mac) && filesRoot !== undefined) {
      toggleFiles();
    } else if (
      !settingsOpen &&
      matchesBinding(event, keys("toggle-source-control"), mac) &&
      gitRoot !== undefined
    ) {
      toggleGit();
    } else if (
      !settingsOpen &&
      matchesBinding(event, keys("toggle-github-panel"), mac) &&
      githubRoot !== undefined
    ) {
      toggleGitHub();
    } else if (!settingsOpen && matchesBinding(event, keys("stop-all"), mac)) {
      askStopAll();
    } else if (matchesBinding(event, keys("open-settings"), mac)) {
      setSettingsOpen(!settingsOpen);
    } else if (settingsOpen) {
      return;
    } else if (matchesBinding(event, keys("toggle-sidebar"), mac)) {
      toggleSidebar();
    } else if (matchesBinding(event, keys("new-thread"), mac)) {
      newThread();
    } else if (matchesBinding(event, keys("command-palette"), mac)) {
      setSearchOpen((open) => !open);
    } else if (matchesBinding(event, keys("toggle-agents"), mac)) {
      if (selected === undefined) return;
      toggleInspector();
    } else if (matchesBinding(event, keys("find-in-thread"), mac)) {
      // The files panel's binding prevents default before the window hears it, and keeps the key.
      if (event.defaultPrevented) return;
      openFind();
    } else {
      return;
    }
    event.preventDefault();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Middle click never latches Chromium's autoscroll (the round arrows a website scrolls with):
  // the only middle click with a job of its own is a files row opening a thread tab.
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, []);

  /**
   * Starts a thread from the draft `draft`, whichever pane it's in, and sends it the first message.
   * Multi agent starts one with each setup: the first takes the draft's tab and pane, and the rest
   * open in tabs after it and in panes to its right, as many as have the room.
   */
  const startThread = async (
    draft: string,
    message: OutgoingMessage,
    setups: readonly [ThreadSetup, ...Array<ThreadSetup>],
    newFolder: string | undefined,
  ) => {
    const title = (message.text.split("\n")[0] || message.attachments[0]?.name || "New thread").slice(0, 80);
    // The threads of one multi-agent run share an id, so the sidebar shows them as one.
    const runId = setups.length > 1 ? crypto.randomUUID() : undefined;
    const created = await settleInTurn(setups, ({ worktree, ...lead }) =>
      create({
        payload: {
          title,
          mode,
          ...(mode === "work" && newFolder ? { cwd: newFolder } : {}),
          ...(worktree ? { worktree } : {}),
          ...(runId ? { runId } : {}),
          lead,
        },
      }),
    );
    const started = created.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const [first, ...others] = started;
    if (first === undefined) throw (created[0] as PromiseRejectedResult).reason;
    const beside = others.map(({ thread }) => thread.id as string);
    tabs.started(draft, first.thread.id, beside);
    const shownBefore = openKey.current ?? draft;
    setPanesByMode((all) => {
      const stored = all[mode];
      const before = stored ?? (beside.length > 0 ? singlePane(MAIN_PANE, shownBefore) : undefined);
      if (before === undefined) return all;
      const renamed = renameKey(before, draft, first.thread.id);
      const target = paneShowing(renamed.root, first.thread.id);
      if (target === undefined || beside.length === 0 || compact) {
        return stored === undefined ? all : { ...all, [mode]: renamed };
      }
      // Each pane keeps the least room a pane has; the threads past what fits wait in their tabs.
      const box = layoutOf(renamed.root).panes.find(({ leaf }) => leaf.id === target.id)?.box;
      const width = (box?.width ?? 0) * (panesArea.current?.getBoundingClientRect().width ?? 0);
      const fit = Math.max(0, Math.floor(width / MIN_PANE.width) - 1);
      const placed = beside.slice(0, fit).map((key) => ({ key, id: newPaneId() }));
      return { ...all, [mode]: spreadBeside(renamed, target.id, placed) };
    });
    setOpenThread((open) =>
      (open[mode] ?? blank[mode]) === draft ? { ...open, [mode]: first.thread.id } : open,
    );
    refreshThreads();
    const sent = await settleInTurn(started, ({ lead }) =>
      send({ payload: { agentId: lead.id, ...message } }),
    );
    const unsent = sent.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    // The draft comes back only when no thread took the message; else the ones that didn't say so.
    if (unsent.length === sent.length) throw unsent[0];
    const failed = setups.length - started.length + unsent.length;
    const reason = created.find((result) => result.status === "rejected")?.reason ?? unsent[0];
    if (failed > 0) {
      setActionError(`${failed} of ${setups.length} threads didn't start: ${messageOf(reason)}`);
    }
  };

  const paneActions: ThreadPaneActions = {
    attempt,
    send: (agentId, message) => send({ payload: { agentId, ...message } }),
    edit:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= EDIT_VERSION
        ? (agentId, messageId, message) => edit({ payload: { agentId, messageId, ...message } })
        : undefined,
    restore:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= RESTORE_VERSION
        ? {
            preview: (agentId, messageId) => checkRestore({ payload: { agentId, messageId } }),
            restore: (agentId, messageId) => restore({ payload: { agentId, messageId } }),
          }
        : undefined,
    turnFiles:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= TURN_FILES_VERSION
        ? {
            open: openTurnFile,
            revert: (agentId, turnId, direction) => revertTurn({ payload: { agentId, turnId, direction } }),
          }
        : undefined,
    start: startThread,
    interrupt: (agentId) => interrupt({ payload: { agentId } }),
    steer:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= STEER_VERSION
        ? (agentId) => steer({ payload: { agentId } })
        : undefined,
    withdraw:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= WITHDRAW_VERSION
        ? (agentId, messageId) => withdraw({ payload: { agentId, messageId } })
        : undefined,
    switchLead: (agentId, choice) => switchLead({ payload: { agentId, ...choice } }),
    compact: (agentId) => compactLead({ payload: { agentId } }),
    handOff:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= HANDOFF_VERSION
        ? (agentId, choice) => handOffTo({ payload: { agentId, ...choice } })
        : undefined,
    respond: (agentId, requestId, decision, scope) =>
      respond({ payload: { agentId, requestId, decision, scope } }),
    answerApproval,
    answerSpawn,
    answerQuestion: answerQuestionOf,
    agentActions,
    keep: tabs.keep,
    onSetUp: noHarness ? () => openSettings("harnesses") : undefined,
    chooseFolder,
  };

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

  /** The notices over the open thread's conversation, each dropping in and folding back up. */
  const notices = (
    <>
      <Reveal shift={-6} className="shrink-0">
        {connection === "unreachable" && driven !== undefined ? (
          <UnreachableNotice
            machine={driven.name}
            presence={drivenDevice && !drivenDevice.online ? presenceLabel(drivenDevice) : undefined}
            onBack={WEB ? undefined : () => driveMachine(registry, undefined)}
          />
        ) : backendFailure !== undefined && driven === undefined ? (
          <BackendFailureNotice failure={backendFailure} />
        ) : connection === "unreachable" && !WEB ? (
          <Notice tone="attention">
            Reconnecting to Cerium's backend…
            {import.meta.env.DEV ? (
              <>
                {" "}
                Start it with <code>bun run dev</code>.
              </>
            ) : null}
          </Notice>
        ) : AsyncResult.isFailure(threadsResult) ? (
          <Notice tone="error" clamp>
            {messageOf(Cause.squash(threadsResult.cause))}
          </Notice>
        ) : null}
      </Reveal>
      {/* The main window has the app's own news; a thread's own window, its thread's. */}
      {solo ? null : (
        <>
          {WEB ? null : <UpdateNotice />}
          <WhatsNewHost />
          <ImportDialogHost />
        </>
      )}
      <Reveal shift={-6} className="shrink-0">
        {(actionError ?? exportFailure) ? (
          <Notice
            tone="error"
            clamp
            onDismiss={() => {
              setActionError(undefined);
              setExportFailure(undefined);
            }}
          >
            {actionError ?? exportFailure}
          </Notice>
        ) : null}
      </Reveal>
    </>
  );

  /** A pane showing the thread, or the thread not started yet, `key`. */
  const threadPane = (key: string, focused: boolean) => {
    const resolved = resolve(key);
    const lead = resolved.shown ? leadOf(resolved.shown.agents) !== undefined : false;
    // A thread's own window keeps them with its thread, whichever pane has the focus.
    const opened = key === (solo?.id ?? current);
    // Each of this computer's threads keeps its own browser, beside it in whichever pane shows it.
    const previewed = previewsHere ? resolved.listed?.thread.id : undefined;
    return (
      <ThreadPane
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
        {...(previewed !== undefined && previewDocks.isOpen(previewed)
          ? {
              preview: (
                <PreviewPane
                  key={previewed}
                  threadId={previewed}
                  onClose={() => previewDocks.close(previewed)}
                />
              ),
            }
          : {})}
        focused={focused}
        paneKey={key}
        onHandles={onPaneHandles}
        actions={paneActions}
        slashCommands={slashCommands}
      />
    );
  };

  /** Hands a task to an agent: a new work thread with the task in its message box. */
  const handOff: HandOff = (task) =>
    startThreadFrom({ folder: task.folder, text: task.note ? `${task.title}\n\n${task.note}` : task.title });
  const taskList = (
    <TaskList
      selected={taskPick}
      onSelect={(id) => {
        setTaskPick(id);
        setTasksPane("main");
      }}
      onHandOff={handOff}
    />
  );
  /** Opens a thread an automation started, from its runs. */
  const openAutomationThread = (threadId: string) => {
    const summary = summaries.find((candidate) => candidate.id === threadId);
    if (summary) openSummary(summary);
  };
  const automationList = (
    <AutomationList
      selected={automationPick}
      onSelect={(id) => {
        setAutomationPick(id);
        setAutomationsPane("main");
      }}
      onNew={() => {
        setAutomationPick("new");
        setAutomationsPane("main");
      }}
    />
  );
  /** The picked automation's form, keyed so a switch starts it afresh. */
  const automationDetail = (onClose?: () => void) =>
    automationPick === undefined ? null : (
      <AutomationDetail
        key={automationPick}
        id={automationPick === "new" ? undefined : automationPick}
        available={available}
        {...(onClose ? { onClose } : {})}
        onCreated={setAutomationPick}
        onDeleted={() => {
          setAutomationPick(undefined);
          setAutomationsPane("list");
        }}
        onOpenThread={openAutomationThread}
      />
    );
  /** The Automations page, laid out as the Tasks page is. */
  const automationsPage = compact
    ? {
        title: "Automations",
        list: <ScrollArea className="h-full">{automationList}</ScrollArea>,
        main: automationDetail(),
        pane: automationsPane,
        onBackToList: () => setAutomationsPane("list"),
      }
    : {
        title: "Automations",
        main: (
          <AutomationsPage
            list={automationList}
            detail={automationDetail(() => setAutomationPick(undefined))}
          />
        ),
        pane: "main" as const,
        onBackToList: () => setAutomationPick(undefined),
      };

  /**
   * The Tasks page lays out its own list and the picked task on a wide window; a narrow one shows
   * them a pane at a time.
   */
  const tasksPage = compact
    ? {
        title: "Tasks",
        list: <ScrollArea className="h-full">{taskList}</ScrollArea>,
        main:
          taskPick === undefined ? null : (
            <TaskDetail id={taskPick} onDeleted={() => setTasksPane("list")} onHandOff={handOff} />
          ),
        pane: tasksPane,
        onBackToList: () => setTasksPane("list"),
      }
    : {
        title: "Tasks",
        main: (
          <TasksPage
            list={taskList}
            detail={
              taskPick === undefined ? null : (
                <TaskDetail
                  id={taskPick}
                  onClose={() => setTaskPick(undefined)}
                  onDeleted={() => setTaskPick(undefined)}
                  onHandOff={handOff}
                />
              )
            }
          />
        ),
        pane: "main" as const,
        onBackToList: () => setTaskPick(undefined),
      };

  /** The GitHub page's main area: the pull request or issue picked in its list, in a card of its own. */
  const githubPageMain =
    githubPick === undefined ? (
      <GitHubPageEmpty />
    ) : (
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised max-md:rounded-none max-md:border-0">
        <GitHubTabView
          key={githubKey(githubPick.root, githubPick.kind, githubPick.number)}
          tab={githubPick}
          worktrees={worktreesOk}
          onStartThread={({ text, worktree }) => startThreadFrom({ folder: githubPick.root, text, worktree })}
          {...(issuesOk
            ? {
                issue: (tab: GitHubTab) => (
                  <IssueViewer
                    cwd={tab.root}
                    number={tab.number}
                    onClose={() => setGithubPick(undefined)}
                    onStartThread={(text) => startThreadFrom({ folder: tab.root, text })}
                    onOpenPull={(number) => setGithubPick({ root: tab.root, kind: "pr", number })}
                  />
                ),
              }
            : {})}
          onClose={() => {
            setGithubPick(undefined);
            setGithubPane("list");
          }}
        />
      </div>
    );

  /** A pane showing the tab `key`: a file, read-only, or a thread. */
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
          key={key}
          tab={github}
          worktrees={worktreesOk}
          onStartThread={({ text, worktree }) => startThreadFrom({ folder: github.root, text, worktree })}
          {...(issuesOk
            ? {
                issue: (tab: GitHubTab, pane: PaneChrome | undefined) => (
                  <IssueViewer
                    cwd={tab.root}
                    number={tab.number}
                    onClose={() => tabs.actions.onClose([key])}
                    onStartThread={(text) => startThreadFrom({ folder: tab.root, text })}
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
  /** The tabs showing in panes besides the focused one, which say so. */
  const beside = new Set(
    split
      ? leavesOf(panes.root)
          .filter((leaf) => leaf.id !== panes.focused)
          .map((leaf) => leaf.key)
      : [],
  );

  return (
    <AppFrame
      {...(viewed
        ? {
            thread: {
              title: viewed.thread.title,
              ...(viewed.thread.cwd ? { project: baseName(viewed.thread.cwd) } : {}),
            },
          }
        : openFile
          ? { thread: { title: baseName(openFile.path), project: baseName(openFile.root) } }
          : {})}
      mode={mode}
      alone={solo !== undefined}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      onNewThread={newThread}
      pane={pane}
      onBack={() => setPane("list")}
      {...(place === "github"
        ? {
            page: {
              title: "GitHub",
              list: (
                <GitHubPageList
                  selected={
                    githubPick === undefined
                      ? undefined
                      : githubKey(githubPick.root, githubPick.kind, githubPick.number)
                  }
                  onOpen={(tab) => {
                    setGithubPick(tab);
                    setGithubPane("main");
                  }}
                  issues={issuesOk}
                />
              ),
              main: githubPageMain,
              pane: githubPane,
              onBackToList: () => setGithubPane("list"),
            },
          }
        : place === "tasks"
          ? { page: tasksPage }
          : place === "automations" && automationsOk
            ? { page: automationsPage }
            : {})}
      rail={(orientation) => (
        <Rail
          view={settingsOpen ? "settings" : (place ?? (mode === "work" ? "home" : "chat"))}
          onSelect={(view) => {
            if (view === "settings") {
              if (settingsOpen) setSettingsOpen(false);
              else openSettings();
            } else if (view === "github" || view === "tasks" || view === "automations") {
              setSettingsOpen(false);
              setPlace(view);
            } else {
              showThreads();
              setMode(view === "home" ? "work" : "chat");
            }
          }}
          harnesses={indicators}
          onOpenUsage={() => openSettings("usage")}
          hidden={[
            ...(githubOk ? [] : (["github"] as const)),
            ...(automationsOk ? [] : (["automations"] as const)),
          ]}
          orientation={orientation}
        />
      )}
      sidebar={
        <Sidebar
          mode={mode}
          threads={summaries}
          selectedId={viewed?.thread.id ?? (openFile ? undefined : openDraft)}
          onSelectDraft={(draft, newTab) => {
            if (newTab) tabs.openAs(draft.key, "tab");
            openNewDraft(draft);
          }}
          onDiscardDraft={discardDraft}
          draftMachine={(machine) =>
            machine === undefined || machine === thisComputer
              ? undefined
              : { name: nameOf(machine), online: deviceOf(machine)?.online === true }
          }
          onSelect={(threadId, newTab) => {
            const summary = summaries.find((candidate) => candidate.id === threadId);
            if (!summary) return;
            if (newTab) tabs.openAs(threadId, "tab");
            openSummary(summary);
          }}
          onNewThread={newThread}
          onMarkRead={(threads) => {
            if (threads.some((thread) => thread.id === heldUnread)) setHeldUnread(undefined);
            readState.markRead(threads);
          }}
          onMarkUnread={(threadId) => {
            if (threadId === viewed?.thread.id) setHeldUnread(threadId);
            readState.markUnread(threadId);
          }}
          onNewThreadIn={(picked) => {
            chooseFolder(picked);
            void save({ payload: { path: picked } }).catch(() => undefined);
            newThread();
          }}
          onRename={(threadId, title) =>
            attempt(rename({ payload: { threadId: threadId as ThreadId, title } })).then((renamed) => {
              if (renamed) refreshThreads();
              return renamed;
            })
          }
          // A thread whose worktree holds work its base doesn't asks first.
          // Each resolves whether the thread went, so the sidebar's bulk bar reports what worked.
          onArchive={(threadId): Promise<boolean> => {
            const thread = summaries.find((summary) => summary.id === threadId);
            if (thread?.worktree === undefined) return archive(threadId);
            return changesOf({ payload: { threadId: threadId as ThreadId } }).then(
              (changes) => {
                if (changes.uncommitted + changes.unmerged === 0) return archive(threadId);
                setArchiving({ thread, changes });
                return false;
              },
              (error: unknown) => {
                setActionError(messageOf(error));
                return false;
              },
            );
          }}
          onRestore={(threadId): Promise<boolean> =>
            attempt(setArchived({ payload: { threadId: threadId as ThreadId, archived: false } })).then(
              (restored) => {
                if (restored) refreshThreads();
                return restored;
              },
            )
          }
          // Deleting a thread closes its tab.
          // Its dialog said a worktree goes with it.
          onDelete={(threadId): Promise<boolean> =>
            attempt(remove({ payload: { threadId: threadId as ThreadId, discardWork: true } })).then(
              (deleted) => {
                if (!deleted) return false;
                registry.set(draftsAtom, withoutDraft(registry.get(draftsAtom), threadId));
                previewDocks.close(threadId);
                refreshThreads();
                tabs.drop(threadId);
                return true;
              },
            )
          }
          {...(drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= LATER_VERSION
            ? {
                onLater: (threadId: string, until: number | undefined): Promise<boolean> =>
                  attempt(
                    putOff({
                      payload: { threadId: threadId as ThreadId, ...(until === undefined ? {} : { until }) },
                    }),
                  ).then((done) => {
                    if (done) refreshThreads();
                    return done;
                  }),
              }
            : {})}
          {...(openInWindow ? { onOpenWindow: openInWindow } : {})}
          open={tabs.tabs.map((tab) => tab.key)}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          commands={paletteCommands}
          messageSearch={
            drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= THREAD_SEARCH_VERSION
          }
        />
      }
      machinePicker={<MachinePicker account={account} />}
      tabs={
        <ThreadTabs
          tabs={
            beside.size === 0 ? tabs.tabs : tabs.tabs.map((tab) => ({ ...tab, beside: beside.has(tab.key) }))
          }
          active={current}
          newLabel={mode === "work" ? "New thread" : "New chat"}
          {...tabs.actions}
          onSplit={(key, side) => splitWith(panes.focused, side, key)}
          {...(openInWindow ? { onOpenWindow: openInWindow } : {})}
        />
      }
      {...(searchOpen ? { closeDialog: () => setSearchOpen(false) } : {})}
      settings={{
        open: settingsOpen,
        nav: (
          <SettingsNav
            category={settingsCategory}
            onSelect={(category) => {
              setSettingsCategory(category);
              setSettingsPane("page");
            }}
            active={settingsOpen}
            compact={compact}
          />
        ),
        page: (
          <SettingsView category={settingsCategory} harnesses={indicators} onOpen={setSettingsCategory} />
        ),
        pane: settingsPane,
        title: settingsLabel(settingsCategory),
        onBackToNav: () => setSettingsPane("nav"),
        onClose: () => setSettingsOpen(false),
      }}
      agents={selected ? selected.agents.map((agent) => agent.provider) : []}
      side={
        inspectorOpen && selected
          ? {
              panel: "agents",
              content: (
                <Inspector
                  agents={agents}
                  selectedId={inspectedAgent}
                  onSelect={setInspectedAgent}
                  onClose={() => closePanel("agents")}
                  onMessageLead={() => focusComposer()}
                  onInterrupt={(agentId) => attempt(interrupt({ payload: { agentId: agentId as AgentId } }))}
                  onStop={(agentId) => attempt(stop({ payload: { agentId: agentId as AgentId } }))}
                  {...(canStopAll ? { onStopAll: askStopAll } : {})}
                  onAnswerApproval={answerApproval}
                  onAnswerSpawn={answerSpawn}
                  onAnswerQuestion={answerQuestionOf}
                />
              ),
            }
          : filesOpen && filesPanel !== undefined
            ? { panel: "files", content: filesPanel }
            : gitOpen && sourceControl !== undefined
              ? { panel: "git", content: sourceControl }
              : githubPanel !== undefined
                ? { panel: "github", content: githubPanel }
                : artifactsOpen && artifactsAvailable && viewed
                  ? {
                      panel: "artifacts",
                      content: (
                        <ArtifactsPanel
                          threadId={viewed.thread.id}
                          artifacts={viewedArtifacts}
                          project={artifactsProject}
                          threadTitle={(threadId) => threadOf(threadId)?.title}
                          folderOf={(threadId) => threadOf(threadId)?.cwd}
                          onShow={showArtifact}
                          onReply={
                            cloudSelected
                              ? undefined
                              : (text) => messageBox.append({ segments: [{ kind: "text", text }] })
                          }
                          onClose={() => closePanel("artifacts")}
                        />
                      ),
                    }
                  : undefined
      }
      panels={{
        ...(selected ? { agents: inspectorOpen } : {}),
        ...(filesRoot === undefined ? {} : { files: filesOpen }),
        ...(gitRoot === undefined ? {} : { git: gitOpen }),
        ...(githubRoot === undefined ? {} : { github: githubOpen }),
        ...(artifactsAvailable ? { artifacts: artifactsOpen } : {}),
      }}
      onTogglePanel={togglePanel}
      onCloseSide={() => setSidePanel(undefined)}
      {...(terminal.available ? { terminal: { open: terminal.open, onToggle: terminal.toggle } } : {})}
      {...(runThreadId === undefined ? {} : { run: { running: runRunning, onToggle: toggleRun } })}
      {...(previewThread === undefined
        ? {}
        : {
            preview: {
              open: previewOpen,
              live: previews[previewThread] !== undefined,
              onToggle: togglePreview,
            },
          })}
    >
      {compact ? (
        // The narrow window shows one pane: the open tab's.
        paneContent(current, true)
      ) : (
        <div ref={panesArea} className="h-full">
          <SplitView
            panes={panes}
            renderPane={(leaf, focused, chrome) => paneContent(leaf.key, focused, chrome)}
            label={paneLabel}
            onFocus={focusOn}
            onResize={(path, sizes) => applyPanes(resizeSplit(panes, path, sizes))}
            onClose={closePaneOf}
            onSplit={splitNew}
            canDrop={canDrop}
            onDrop={dropOn}
          />
        </div>
      )}
      {/* The main window keeps the account's syncs and hosts the agents' browser. */}
      {solo ? null : (
        <>
          <DraftSync signedIn={account._tag === "SignedIn"} here={WEB ? undefined : thisComputer} />
          {previewBridge() === undefined ? null : <BrowserHost onOpened={agentOpened} />}
          <TaskSync signedIn={account._tag === "SignedIn"} />
        </>
      )}
      {selected ? (
        <StopAllDialog
          scope={stopScope}
          open={stopAllOpen && canStopAll}
          onOpenChange={setStopAllOpen}
          onConfirm={() => void attempt(stopEverything({ payload: { threadId: selected.thread.id } }))}
        />
      ) : null}
      {archiving?.thread.worktree ? (
        <ArchiveWorktreeDialog
          thread={{ ...archiving.thread, worktree: archiving.thread.worktree }}
          changes={archiving.changes}
          open
          onOpenChange={(open) => {
            if (!open) setArchiving(undefined);
          }}
          onConfirm={() => void archive(archiving.thread.id, true)}
        />
      ) : null}
    </AppFrame>
  );
}
