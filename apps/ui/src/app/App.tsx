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
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  ArchiveRestore,
  Bot,
  Columns2,
  FolderTree,
  GitBranch,
  GitPullRequestArrow,
  MessagesSquare,
  OctagonX,
  PanelLeft,
  RotateCcw,
  Rows2,
  ScrollText,
  Settings,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  accountAtom,
  accountThreadsAtom,
  cloudEventsAtom,
  createThread,
  deleteThread,
  editMessage,
  harnessesAtom,
  interruptAgent,
  localWorkingAtom,
  markThreadsRead,
  previewRestore,
  renameThread,
  resolveSpawnApproval,
  restoreBefore,
  respondToPermission,
  steerAgent,
  answerQuestion,
  sendMessage,
  setThreadArchived,
  setThreadLater,
  settledEventsAtom,
  stopAgent,
  stopThread,
  switchModel,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { refreshIssueList } from "../backend/issues.ts";
import { driveMachine, machineAtom, machineKey, machineToDrive } from "../backend/machine.ts";
import { saveProject, worktreeChanges } from "../backend/projects.ts";
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
import { STOP_ALL_SHORTCUT, STOP_THREAD_VERSION, stopAllScope } from "../features/agents/model.ts";
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
import { useModels } from "../features/composer/models.ts";
import { useLatestProject } from "../features/composer/ProjectPicker.tsx";
import { useDraftSync } from "../features/composer/useDraftSync.ts";
import { FILES_VERSION, type OpenFile } from "../features/files/model.ts";
import type { PaletteCommand } from "../features/palette/palette.ts";
import { useFilesExplorer } from "../features/files/useFilesExplorer.tsx";
import { GIT_VERSION } from "../features/git/model.ts";
import { useSourceControl } from "../features/git/useSourceControl.tsx";
import { GitHubPanel } from "../features/github/GitHubPanel.tsx";
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
import { PROJECT_TERMINAL_VERSION, TERMINAL_VERSION } from "../features/terminal/model.ts";
import { useTerminalDrawer } from "../features/terminal/useTerminalDrawer.tsx";
import { scaleAtom, stepScale, themeAtom } from "../features/settings/preferences.ts";
import { canScale, scaleShortcut, useScale } from "../features/settings/scale.ts";
import {
  settingsLabel,
  SettingsNav,
  settingsPages,
  SettingsView,
  type SettingsCategory,
} from "../features/settings/Settings.tsx";
import { useTheme } from "../features/settings/theme.ts";
import { ThreadTabs } from "../features/tabs/ThreadTabs.tsx";
import { useThreadTabs } from "../features/tabs/useThreadTabs.ts";
import { CloudThreadBar, LoadingThreadBar, NoComputerBar } from "../features/threads/CloudThread.tsx";
import { useReadState } from "../features/threads/readState.ts";
import { ArchiveWorktreeDialog } from "../features/threads/ArchiveWorktree.tsx";
import { LATER_VERSION, type ThreadSummary } from "../features/threads/model.ts";
import { WORKTREE_VERSION } from "../features/threads/worktree.ts";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { THREAD_SEARCH_VERSION } from "../features/threads/threadSearch.ts";
import { EDIT_VERSION, STEER_VERSION } from "../features/transcript/model.ts";
import { RESTORE_VERSION } from "../features/transcript/restore.ts";
import { revertTurnFiles, TURN_FILES_VERSION } from "../backend/turnFiles.ts";
import { ThreadMark } from "../features/threads/StatusIndicator.tsx";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { whatsNewOpenAtom } from "../features/whatsnew/state.ts";
import { WhatsNewHost } from "../features/whatsnew/WhatsNewHost.tsx";
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
import { primaryHeld } from "../lib/keys.ts";
import { remember, stored } from "../lib/storage.ts";
import { useMatchingBuild } from "../web/builds.ts";
import { useDesktopNotifications } from "../desktop/notifications.ts";
import { useNotificationOpens, useRenewPush } from "../web/push.ts";
import { WebGate } from "../web/WebGate.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { useLaunched } from "./launch.ts";
import { Launch } from "./LaunchScreen.tsx";
import { useCompact } from "./compact.ts";
import type { AppMode } from "./ModeSwitch.tsx";
import { Notice } from "./Notice.tsx";
import type { SidePanelId } from "./panelLayout.ts";
import { freshBlank, rememberSession, restoredSession } from "./session.ts";
import { TextMenu } from "./TextMenu.tsx";
import { ThreadPane, type PaneHandles, type ThreadPaneActions } from "./ThreadPane.tsx";

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
  return children;
}

function Workspace() {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  /** Where this tab was before a reload; it comes back once the window drives the same machine. */
  const [session] = useState(restoredSession);
  // Compared on its own line: the React Compiler skips a component whose ternary tests an optional chain.
  const sameMachine = session?.machine === driven?.id;
  const resumed = sameMachine ? session : undefined;
  const [resumePending, setResumePending] = useState(() => session !== undefined && resumed === undefined);
  const [mode, setMode] = useState<AppMode>(() => session?.mode ?? "work");
  /**
   * The open thread per mode, or the draft of a thread not started yet; none means the mode's blank
   * new thread.
   */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>(() => resumed?.open ?? {});
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
      comment: (content) => box()?.comment(content),
    };
  });
  const [onPaneHandles] = useState(() => (key: string, handles: PaneHandles | undefined) => {
    if (handles) paneHandles.current.set(key, handles);
    else paneHandles.current.delete(key);
  });

  const connection = useAtomValue(connectionAtom);
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnessesResult = useAtomValue(harnessesAtom);
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
  useDraftSync(account._tag === "SignedIn", WEB ? undefined : thisComputer);
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
  const { listed: selected, cloud: cloudSelected, shown: viewed } = resolve(openThread[mode]);
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
  const markSeen = useEffectEvent(() => {
    if (selectedSummary && readState.isUnread(selectedSummary.id, selectedSummary.updatedAt)) {
      readState.markRead([selectedSummary]);
    }
  });
  useEffect(() => markSeen(), [selectedSummary?.id, selectedSummary?.updatedAt]);
  // The open thread's events: live from the driven machine, or the cloud copy of another machine's.
  // Without streamed text, which nothing here reads: its pane renders that, and the window doesn't.
  const eventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? settledEventsAtom(selected.thread.id)
    : cloudSelected
      ? cloudEventsAtom(`${cloudSelected.machine}:${cloudSelected.overview.thread.id}`)
      : noEvents;
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  /** Opens another machine's thread there: the window drives that machine, then shows it. */
  const openOn = (device: DeviceInfo, threadId: string, threadMode: AppMode = mode) => {
    setOpenAfterSwitch({ mode: threadMode, id: threadId });
    setPane("main");
    driveMachine(registry, device.id === thisComputer ? undefined : { id: device.id, name: device.name });
  };
  /** Opens a thread of the inbox: another machine's there when it can, else here (read-only when it's another's). */
  const openSummary = (summary: ThreadSummary) => {
    setSettingsOpen(false);
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
      setSettingsOpen(false);
      setOpenThread((current) => ({ ...current, [mode]: key }));
      setPane("main");
    },
    onFresh: (key) => {
      setSettingsOpen(false);
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
    if (resumePending) return;
    rememberSession({
      ...(driven ? { machine: driven.id } : {}),
      mode,
      open: openThread,
      blank,
      pane,
      tabs: tabs.strips,
      panes: panesByMode,
    });
  }, [resumePending, driven, mode, openThread, blank, pane, tabs.strips, panesByMode]);

  // A tapped notification opens its thread, once the inbox lists it.
  useNotificationOpens(
    (threadId) => summaries.find((summary) => summary.id === threadId),
    (summary) => {
      setSettingsOpen(false);
      setMode(summary.mode);
      openSummary(summary);
    },
  );
  useRenewPush(account);
  const threadShown = viewed !== undefined && !settingsOpen && (!compact || pane === "main");
  // Nobody is told about the thread this window shows, unless settings or the narrow
  // window's inbox cover it.
  useAccountPresence(
    account,
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
  const create = useAtomSet(createThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const edit = useAtomSet(editMessage, { mode: "promise" });
  const checkRestore = useAtomSet(previewRestore, { mode: "promise" });
  const restore = useAtomSet(restoreBefore, { mode: "promise" });
  const revertTurn = useAtomSet(revertTurnFiles, { mode: "promise" });
  const switchLead = useAtomSet(switchModel, { mode: "promise" });
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
  const answer = useAtomSet(answerQuestion, { mode: "promise" });
  const resolveSpawn = useAtomSet(resolveSpawnApproval, { mode: "promise" });
  const interrupt = useAtomSet(interruptAgent, { mode: "promise" });
  const steer = useAtomSet(steerAgent, { mode: "promise" });
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

  /** Archives a thread and closes its tab; `discardWork` once the user confirmed losing its worktree's work. */
  const archive = (threadId: string, discardWork = false) =>
    void attempt(
      setArchived({
        payload: { threadId: threadId as ThreadId, archived: true, ...(discardWork ? { discardWork } : {}) },
      }),
    ).then((archived) => {
      if (!archived) return;
      refreshThreads();
      tabs.drop(threadId);
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
  /** Opens the folder `root`'s files in the viewer. */
  const openerIn =
    (root: string): OpenFile =>
    (path, options) => {
      const key = fileKey(root, path);
      // From the Changes list, a file opens on what changed.
      if (options?.changes === true) registry.set(fileViewAtom(key), "diff");
      // A tab of its own, beside the thread. A preview would take the thread's tab while that thread
      // is only being read.
      tabs.openAs(key, "tab");
      tabs.keep(key);
      setSettingsOpen(false);
      setOpenThread((open) => ({ ...open, [mode]: key }));
      setPane("main");
      // The narrow window shows one pane: the file takes the panel's place.
      if (compact) setSidePanel(undefined);
    };
  const openInViewer = filesRoot === undefined || !viewerOk ? undefined : openerIn(filesRoot);
  /** Opens the folder `root`'s file as one commit changed it, in a tab of its own, as the viewer's files open. */
  const openCommitFileIn =
    (root: string) => (sha: string, file: { readonly path: string; readonly from?: string }) => {
      const key = commitFileKey(root, sha, file.path, file.from);
      tabs.openAs(key, "tab");
      tabs.keep(key);
      setSettingsOpen(false);
      setOpenThread((open) => ({ ...open, [mode]: key }));
      setPane("main");
      if (compact) setSidePanel(undefined);
    };
  /** Opens a file as one of an agent's turns changed it, in a tab of its own, as a commit's files open. */
  const openTurnFile = (tab: TurnFileTab) => {
    const key = turnFileKey(tab);
    tabs.openAs(key, "tab");
    tabs.keep(key);
    setSettingsOpen(false);
    setOpenThread((open) => ({ ...open, [mode]: key }));
    setPane("main");
    if (compact) setSidePanel(undefined);
  };
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
  const filesPanel = useFilesExplorer({
    root: filesRoot,
    events,
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
  /** The machine has the issue calls; an older one has the pull requests alone. */
  const issuesOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= ISSUES_VERSION;
  const toggleGitHub = () => togglePanel("github");
  /** Opens a pull request or an issue of `root`'s repository in a tab of its own, as files open. */
  const openGitHubIn = (root: string, kind: GitHubKind, number: number, title?: string) => {
    const key = githubKey(root, kind, number);
    if (title !== undefined) nameGitHubTab(registry, key, title);
    tabs.openAs(key, "tab");
    tabs.keep(key);
    setSettingsOpen(false);
    setOpenThread((open) => ({ ...open, [mode]: key }));
    setPane("main");
    if (compact) setSidePanel(undefined);
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
    folder: string;
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
          folder: projectOf(folder),
          ...(driven ? { machine: driven.id } : {}),
          ...(worktree === undefined || !worktreesOk ? {} : { worktree }),
        }),
      })),
    );
    setSettingsOpen(false);
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
      if (summary === undefined) return;
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
    setSettingsOpen(false);
    tabs.newTab();
    focusComposer();
  };

  /** Opens a thread not started yet, on the machine it starts on. */
  const openNewDraft = (draft: NewThreadDraft) => {
    setSettingsOpen(false);
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
  // Back from settings, the cursor returns to the message box; a phone's keyboard stays down.
  useEffect(() => {
    if (!settingsOpen && !compact) focusComposer();
  }, [settingsOpen, compact]);

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
    setSettingsOpen(false);
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
   * What the command palette (Ctrl K) runs besides opening a thread. To offer a new action, add an entry
   * to the "Actions" below: `keys` shows the shortcut it already has, `when` hides it while it can't run.
   */
  const paletteCommands: ReadonlyArray<PaletteCommand> = [
    {
      id: "new-thread",
      group: "Actions",
      label: mode === "work" ? "New thread" : "New chat",
      icon: SquarePen,
      keys: "Ctrl N",
      run: newThread,
    },
    {
      id: "sidebar",
      group: "Actions",
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: PanelLeft,
      keys: "Ctrl B",
      run: toggleSidebar,
    },
    {
      id: "agents",
      group: "Actions",
      label: inspectorOpen ? "Hide agents" : "Show agents",
      icon: Bot,
      keys: "Ctrl J",
      keywords: "inspector",
      when: selected !== undefined,
      run: toggleInspector,
    },
    {
      id: "stop-all",
      group: "Actions",
      label: "Stop everything",
      icon: OctagonX,
      keys: STOP_ALL_SHORTCUT,
      keywords: "interrupt cancel halt agents deny approvals",
      when: canStopAll,
      run: askStopAll,
    },
    {
      id: "files",
      group: "Actions",
      label: filesOpen ? "Hide files" : "Show files",
      icon: FolderTree,
      keys: "Ctrl Shift E",
      when: filesRoot !== undefined,
      run: toggleFiles,
    },
    {
      id: "source-control",
      group: "Actions",
      label: gitOpen ? "Hide source control" : "Show source control",
      icon: GitBranch,
      keys: "Ctrl Shift G",
      keywords: "git changes stage commit",
      when: gitRoot !== undefined,
      run: toggleGit,
    },
    {
      id: "github",
      group: "Actions",
      label: githubOpen ? "Hide GitHub" : "Show GitHub",
      icon: GitPullRequestArrow,
      keys: "Ctrl Shift H",
      keywords: "pull requests prs issues reviews",
      when: githubRoot !== undefined,
      run: toggleGitHub,
    },
    {
      id: "terminal",
      group: "Actions",
      label: terminal.open ? "Hide terminal" : "Show terminal",
      icon: SquareTerminal,
      keys: "Control `",
      when: terminal.available,
      run: terminal.toggle,
    },
    {
      id: "mode",
      group: "Actions",
      label: mode === "work" ? "Switch to Chat" : "Switch to Work",
      icon: MessagesSquare,
      keys: mode === "work" ? "Ctrl Shift 2" : "Ctrl Shift 1",
      run: () => {
        setSettingsOpen(false);
        setMode(mode === "work" ? "chat" : "work");
      },
    },
    {
      id: "split-right",
      group: "Actions",
      label: "Split right",
      icon: Columns2,
      keys: "Ctrl \\",
      keywords: "new thread beside pane",
      when: !compact,
      run: () => splitNew(panes.focused, "right"),
    },
    {
      id: "split-below",
      group: "Actions",
      label: "Split below",
      icon: Rows2,
      keys: "Ctrl Shift \\",
      keywords: "new thread pane",
      when: !compact,
      run: () => splitNew(panes.focused, "bottom"),
    },
    {
      id: "close-tab",
      group: "Actions",
      label: "Close tab",
      icon: X,
      keys: "Ctrl W",
      when: !compact,
      run: tabs.closeActive,
    },
    {
      id: "reopen-tab",
      group: "Actions",
      label: "Reopen closed tab",
      icon: RotateCcw,
      keys: "Ctrl Shift T",
      when: !compact,
      run: tabs.reopen,
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
    {
      id: "settings",
      group: "Actions",
      label: "Open settings",
      icon: Settings,
      keys: "Ctrl ,",
      run: () => openSettings(),
    },
    {
      id: "whats-new",
      group: "Actions",
      label: "What's new",
      icon: ScrollText,
      keywords: "changelog release notes updates",
      run: () => openWhatsNew(true),
    },
    ...settingsPages.map(({ id, label, icon }): PaletteCommand => ({
      id: `settings-${id}`,
      group: "Settings",
      label,
      icon,
      keywords: "settings",
      run: () => openSettings(id),
    })),
  ];

  /**
   * The keys that step through and move the tabs, with Control as browsers have them (a Mac's too,
   * whose ⌘Tab switches apps); whether `event` was one.
   */
  const tabStepShortcut = (event: KeyboardEvent) => {
    if (event.key === "Tab") tabs.step(event.shiftKey ? -1 : 1);
    else if (event.key === "PageDown" || event.key === "PageUp") {
      const by = event.key === "PageDown" ? 1 : -1;
      if (event.shiftKey) tabs.shift(by);
      else tabs.step(by);
    } else return false;
    return true;
  };

  /** The tabs' other keys with Ctrl (⌘ on a Mac), as browsers have them; whether `event` was one. */
  const tabShortcut = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "t") {
      if (event.shiftKey) tabs.reopen();
      else newThread();
    } else if (event.key.toLowerCase() === "w" && !event.shiftKey) tabs.closeActive();
    else return false;
    return true;
  };

  // The shortcuts the window's buttons advertise in their tooltips.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    // Esc backs out of settings, unless something inside them (an open menu) already used it.
    if (event.key === "Escape" && settingsOpen && !event.defaultPrevented) {
      setSettingsOpen(false);
      return;
    }
    // Alt and a digit goes to a tab, as Ctrl and a digit opens a sidebar row.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined || settingsOpen || searchOpen || compact) return;
      tabs.goTo(Number(digit));
      event.preventDefault();
      return;
    }
    const control = event.ctrlKey && !event.metaKey && !event.altKey;
    if (control && !searchOpen && !settingsOpen && !compact && tabStepShortcut(event)) {
      event.preventDefault();
      return;
    }
    // Ctrl is ⌘ in the Mac app (lib/keys.ts).
    if (!primaryHeld(event) || event.altKey) return;
    // Ctrl + and Ctrl − scale the desktop window wherever focus is; a browser zooms the page itself.
    const scaling = canScale() ? scaleShortcut(event) : undefined;
    if (scaling !== undefined) {
      registry.set(scaleAtom, scaling === "reset" ? 100 : stepScale(registry.get(scaleAtom), scaling));
      event.preventDefault();
      return;
    }
    // Search has the keys while it's open, but for Ctrl K, which closes it.
    if (searchOpen && event.key.toLowerCase() !== "k") return;
    if (!settingsOpen && !compact && tabShortcut(event)) {
      event.preventDefault();
      return;
    }
    // Ctrl \ opens a new thread beside the focused pane, and with Shift, below it.
    if (event.code === "Backslash" && !settingsOpen && !compact) {
      splitNew(panes.focused, event.shiftKey ? "bottom" : "right");
      event.preventDefault();
      return;
    }
    if (event.shiftKey) {
      // Ctrl and a digit alone opens a sidebar row, which the sidebar listens for.
      if (event.code === "Digit1" || event.code === "Digit2") {
        setSettingsOpen(false);
        setMode(event.code === "Digit1" ? "work" : "chat");
      } else if (event.key.toLowerCase() === "e" && !settingsOpen && filesRoot !== undefined) {
        toggleFiles();
      } else if (event.key.toLowerCase() === "g" && !settingsOpen && gitRoot !== undefined) {
        toggleGit();
      } else if (event.key.toLowerCase() === "h" && !settingsOpen && githubRoot !== undefined) {
        toggleGitHub();
      } else if ((event.code === "Period" || event.key === ">") && !settingsOpen) {
        askStopAll();
      } else return;
      event.preventDefault();
      return;
    }
    switch (event.key.toLowerCase()) {
      case ",":
        setSettingsOpen(!settingsOpen);
        break;
      case "b":
        if (settingsOpen) return;
        toggleSidebar();
        break;
      case "n":
        newThread();
        break;
      case "k":
        if (settingsOpen) return;
        setSearchOpen((open) => !open);
        break;
      case "j":
        if (selected === undefined || settingsOpen) return;
        toggleInspector();
        break;
      default:
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
    const created = await settleInTurn(setups, ({ worktree, ...lead }) =>
      create({
        payload: {
          title,
          mode,
          ...(mode === "work" && newFolder ? { cwd: newFolder } : {}),
          ...(worktree ? { worktree } : {}),
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
    switchLead: (agentId, choice) => switchLead({ payload: { agentId, ...choice } }),
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

  /** The notices over the open thread's conversation. */
  const notices = (
    <>
      {connection === "unreachable" && driven !== undefined ? (
        <UnreachableNotice
          machine={driven.name}
          presence={drivenDevice && !drivenDevice.online ? presenceLabel(drivenDevice) : undefined}
          onBack={WEB ? undefined : () => driveMachine(registry, undefined)}
        />
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
      {WEB ? null : <UpdateNotice />}
      <WhatsNewHost />
      {actionError ? (
        <Notice tone="error" clamp onDismiss={() => setActionError(undefined)}>
          {actionError}
        </Notice>
      ) : null}
    </>
  );

  /** A pane showing the thread, or the thread not started yet, `key`. */
  const threadPane = (key: string, focused: boolean) => {
    const resolved = resolve(key);
    const lead = resolved.shown ? leadOf(resolved.shown.agents) !== undefined : false;
    const opened = key === current;
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
        focused={focused}
        paneKey={key}
        onHandles={onPaneHandles}
        actions={paneActions}
      />
    );
  };

  /** A pane showing the tab `key`: a file, read-only, or a thread. */
  const paneContent = (key: string, focused: boolean, chrome?: PaneChrome) => {
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
      return <TurnFileView key={key} tab={turn} onClose={() => tabs.actions.onClose([key])} pane={chrome} />;
    }
    const file = fileOfKey(key);
    if (file === undefined) return threadPane(key, focused);
    return (
      <FileViewer
        key={key}
        root={file.root}
        path={file.path}
        messageBox={messageBox}
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
      onModeChange={(next) => {
        setSettingsOpen(false);
        setMode(next);
      }}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      onNewThread={newThread}
      pane={pane}
      onBack={() => setPane("list")}
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
          onArchive={(threadId) => {
            const thread = summaries.find((summary) => summary.id === threadId);
            if (thread?.worktree === undefined) return archive(threadId);
            void changesOf({ payload: { threadId: threadId as ThreadId } }).then(
              (changes) =>
                changes.uncommitted + changes.unmerged === 0
                  ? archive(threadId)
                  : setArchiving({ thread, changes }),
              (error: unknown) => setActionError(messageOf(error)),
            );
          }}
          onRestore={(threadId) =>
            void attempt(setArchived({ payload: { threadId: threadId as ThreadId, archived: false } })).then(
              (restored) => {
                if (restored) refreshThreads();
              },
            )
          }
          // Deleting a thread closes its tab.
          // Its dialog said a worktree goes with it.
          onDelete={(threadId) =>
            void attempt(remove({ payload: { threadId: threadId as ThreadId, discardWork: true } })).then(
              (deleted) => {
                if (!deleted) return;
                registry.set(draftsAtom, withoutDraft(registry.get(draftsAtom), threadId));
                refreshThreads();
                tabs.drop(threadId);
              },
            )
          }
          {...(drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= LATER_VERSION
            ? {
                onLater: (threadId: string, until: number | undefined) =>
                  void attempt(
                    putOff({
                      payload: { threadId: threadId as ThreadId, ...(until === undefined ? {} : { until }) },
                    }),
                  ).then((done) => {
                    if (done) refreshThreads();
                  }),
              }
            : {})}
          open={tabs.tabs.map((tab) => tab.key)}
          harnesses={indicators}
          onOpenSettings={openSettings}
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
            backLabel={mode === "work" ? "Back to threads" : "Back to chats"}
            onBack={() => setSettingsOpen(false)}
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
          onConfirm={() => archive(archiving.thread.id, true)}
        />
      ) : null}
    </AppFrame>
  );
}
