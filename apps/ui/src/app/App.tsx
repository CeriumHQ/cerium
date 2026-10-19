import type {
  AccountState,
  AccountThreads,
  AgentEvent,
  DeviceId,
  DeviceInfo,
  AgentId,
  ProviderId,
  ThreadId,
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
import { useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import {
  accountAtom,
  accountThreadsAtom,
  cloudEventsAtom,
  createThread,
  deleteThread,
  harnessesAtom,
  interruptAgent,
  localWorkingAtom,
  markThreadsRead,
  renameThread,
  resolveSpawnApproval,
  respondToPermission,
  sendMessage,
  setThreadArchived,
  stopAgent,
  switchModel,
  threadEventsAtom,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { driveMachine, machineAtom, machineKey, machineToDrive } from "../backend/machine.ts";
import { saveProject } from "../backend/projects.ts";
import { WEB } from "../backend/target.ts";
import { leadOf, modelLabel, toAgentSummaries, toThreadSummary } from "../backend/view.ts";
import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import {
  DeviceRequestNotice,
  UnreachableNotice,
  useAccountPresence,
  useShellPresence,
} from "../features/account/AccountNotice.tsx";
import { MachinePicker } from "../features/account/MachinePicker.tsx";
import { presenceLabel, reachOf } from "../features/account/model.ts";
import { type AgentActions } from "../features/agents/AgentMenu.tsx";
import { ApprovalTray, type AnswerApproval, type AnswerSpawn } from "../features/agents/ApprovalTray.tsx";
import { Inspector } from "../features/agents/Inspector.tsx";
import { Composer, type OutgoingMessage, type ThreadSetup } from "../features/composer/Composer.tsx";
import { hasContent } from "../features/composer/draft.ts";
import {
  draftsAtom,
  draftStartAtom,
  isNewDraftKey,
  newDraftKey,
  withoutDraft,
  type NewThreadDraft,
} from "../features/composer/drafts.ts";
import { useMessageBoxHandle } from "../features/composer/messageBox.ts";
import { useModels } from "../features/composer/models.ts";
import { useLatestProject } from "../features/composer/ProjectPicker.tsx";
import { FILES_VERSION } from "../features/files/model.ts";
import { useFilesExplorer } from "../features/files/useFilesExplorer.tsx";
import { themeAtom } from "../features/settings/preferences.ts";
import {
  settingsLabel,
  SettingsNav,
  SettingsView,
  type SettingsCategory,
} from "../features/settings/Settings.tsx";
import { useTheme } from "../features/settings/theme.ts";
import {
  CloudThreadBar,
  ConnectingNote,
  LoadingThreadBar,
  NoComputerBar,
} from "../features/threads/CloudThread.tsx";
import { useReadState } from "../features/threads/readState.ts";
import type { ThreadSummary } from "../features/threads/model.ts";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { THREAD_SEARCH_VERSION } from "../features/threads/threadSearch.ts";
import { buildTranscript, queuedMessages } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { remember, stored } from "../lib/storage.ts";
import { useMatchingBuild } from "../web/builds.ts";
import { useNotificationOpens, useRenewPush } from "../web/push.ts";
import { WebGate } from "../web/WebGate.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { useCompact } from "./compact.ts";
import { EmptyThread } from "./EmptyThread.tsx";
import type { AppMode } from "./ModeSwitch.tsx";
import { Notice } from "./Notice.tsx";
import { freshBlank, rememberSession, restoredSession } from "./session.ts";
import { TextMenu } from "./TextMenu.tsx";

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];
const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));
const FOLDER_KEY = "cerium:lastFolder";
const SIDEBAR_KEY = "cerium:sidebar";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong.";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function App() {
  return (
    <RegistryProvider>
      <TooltipProvider delay={400}>
        <Themed>
          <WebGate>
            <Workspace />
          </WebGate>
        </Themed>
        <TextMenu />
      </TooltipProvider>
    </RegistryProvider>
  );
}

/** Keeps the page on the chosen theme, the web client's sign-in included. */
function Themed({ children }: { children: ReactNode }) {
  useTheme(useAtomValue(themeAtom));
  return children;
}

function Workspace() {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  /** Where this tab was before a reload; it comes back once the window drives the same machine. */
  const [session] = useState(restoredSession);
  const resumed = session?.machine === driven?.id ? session : undefined;
  const [resumePending, setResumePending] = useState(() => session !== undefined && resumed === undefined);
  const [mode, setMode] = useState<AppMode>(() => session?.mode ?? "work");
  /**
   * The open thread per mode, or the draft of a thread not started yet; none means the mode's blank
   * new thread.
   */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>(() => resumed?.open ?? {});
  /** Each mode's blank new thread: once it has something in it, "New thread" starts another. */
  const [blank, setBlank] = useState(() => resumed?.blank ?? freshBlank());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** The files panel, which takes the inspector's place: one of the two is open at a time. */
  const [filesOpen, setFilesOpen] = useState(false);
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
    if (back) setPane(back.pane);
    setOpenAfterSwitch(undefined);
    setResumePending(false);
  }
  useEffect(() => {
    if (resumePending) return;
    rememberSession({ ...(driven ? { machine: driven.id } : {}), mode, open: openThread, blank, pane });
  }, [resumePending, driven, mode, openThread, blank, pane]);
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const [actionError, setActionError] = useState<string>();
  /** How tall the message box floating over the transcript is, with what sits above it, so the transcript's end stays visible. */
  const [composerHeight, setComposerHeight] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const compact = useCompact();
  /** Its settings pane: the categories, or the open category's page. */
  const [settingsPane, setSettingsPane] = useState<"nav" | "page">("nav");
  /** The category settings open on: the last one visited. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const composerInput = useRef<HTMLDivElement>(null);
  const [messageBoxRef, messageBox] = useMessageBoxHandle();

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
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), (): AccountState => ({
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
  const selected = overviews.find(
    (overview) => overview.thread.id === openThread[mode] && overview.thread.mode === mode,
  );
  /** Another machine's thread open from the cloud copy, read-only, while that machine can't be reached. */
  const cloudSelected = selected
    ? undefined
    : elsewhere.find(
        (each) => each.overview.thread.id === openThread[mode] && each.overview.thread.mode === mode,
      );
  const viewed = selected ?? cloudSelected?.overview;
  /**
   * The open thread isn't listed yet because the list hasn't loaded (just after a reload): it holds
   * its place rather than showing the blank new thread, whose draft the user would be writing in.
   */
  const loadingThread =
    viewed === undefined &&
    openThread[mode] !== undefined &&
    !isNewDraftKey(openThread[mode]) &&
    overviews.length === 0 &&
    !AsyncResult.isSuccess(threadsResult);
  /** The thread not started yet the new-thread view shows: one opened from the sidebar, or the blank one. */
  const openDraft = isNewDraftKey(openThread[mode]) ? openThread[mode] : blank[mode];
  const openDraftStart = useAtomValue(draftStartAtom(openDraft));
  const latestProject = useLatestProject();
  /** The folder the new thread starts in: the one chosen for this draft, else the last one, else the project used most recently. */
  const newFolder = openDraftStart?.folder ?? folder ?? latestProject;
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
  useMatchingBuild(drivenDevice, isNewDraftKey(openThread[mode]) ? undefined : openThread[mode]);
  // The web client always drives one of the account's desktops: the one it drove last,
  // else the first that can be reached, once one can.
  const reachable = devices.filter(
    (device) => device.kind === "desktop" && device.approved && reachOf(device).kind === "reachable",
  );
  const toDrive = WEB && driven === undefined ? machineToDrive(reachable) : undefined;
  const driveChosen = useEffectEvent(() => {
    if (toDrive !== undefined) driveMachine(registry, toDrive);
  });
  useEffect(() => driveChosen(), [toDrive?.id]);
  const markSeen = useEffectEvent(() => {
    if (selectedSummary && readState.isUnread(selectedSummary.id, selectedSummary.updatedAt)) {
      readState.markRead([selectedSummary]);
    }
  });
  useEffect(() => markSeen(), [selectedSummary?.id, selectedSummary?.updatedAt]);
  // The open thread's events: live from the driven machine, or the cloud copy of another machine's.
  const eventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? threadEventsAtom(selected.thread.id)
    : cloudSelected
      ? cloudEventsAtom(`${cloudSelected.machine}:${cloudSelected.overview.thread.id}`)
      : noEvents;
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const cloudDevice = cloudSelected ? deviceOf(cloudSelected.machine) : undefined;
  /** The open thread's machine is the one the window drives, and it hasn't answered yet. */
  const cloudConnecting =
    cloudSelected !== undefined &&
    cloudSelected.machine === drivenId &&
    cloudDevice !== undefined &&
    reachOf(cloudDevice).kind === "reachable";
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
  // Nobody is told about the thread this window shows, unless settings or the narrow
  // window's inbox cover it.
  useAccountPresence(
    account,
    viewed && drivenId !== undefined && !settingsOpen && (!compact || pane === "main")
      ? {
          machine: (cloudSelected?.machine ?? drivenId) as DeviceId,
          threadId: viewed.thread.id,
        }
      : undefined,
  );

  const create = useAtomSet(createThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const switchLead = useAtomSet(switchModel, { mode: "promise" });
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
  const resolveSpawn = useAtomSet(resolveSpawnApproval, { mode: "promise" });
  const interrupt = useAtomSet(interruptAgent, { mode: "promise" });
  const stop = useAtomSet(stopAgent, { mode: "promise" });
  const rename = useAtomSet(renameThread, { mode: "promise" });
  const setArchived = useAtomSet(setThreadArchived, { mode: "promise" });
  const remove = useAtomSet(deleteThread, { mode: "promise" });
  const save = useAtomSet(saveProject, { mode: "promise" });
  /** Runs a backend action, reporting a failure in the notice bar; resolves whether it worked. */
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

  const indicators: ReadonlyArray<HarnessIndicator> = providers.map((provider) => {
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

  const lead = viewed ? leadOf(viewed.agents) : undefined;
  const agents = viewed ? toAgentSummaries(viewed.agents, events, models) : [];
  const leadModel =
    agents.find((agent) => agent.id === lead?.id)?.model ??
    (lead ? modelLabel(models, lead.provider, lead.model) : "");
  const leadRunning = lead?.state === "running" || lead?.state === "queued";
  // An ended lead picks the thread back up on the user's next message.
  const leadEnded = lead?.state === "stopped" || lead?.state === "failed" ? lead.state : undefined;
  const leadEvents = lead ? events.filter((event) => event.agentId === lead.id) : [];
  const toggleInspector = () => {
    setInspectorOpen(!inspectorOpen);
    setFilesOpen(false);
  };
  const toggleFiles = () => {
    setFilesOpen(!filesOpen);
    setInspectorOpen(false);
  };
  /** The open work thread's folder can be browsed here: it's on the machine the window drives, which knows how. */
  const filesRoot =
    selected?.thread.mode === "work" &&
    selected.thread.cwd !== undefined &&
    (drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= FILES_VERSION)
      ? selected.thread.cwd
      : undefined;
  const explorer = useFilesExplorer({
    root: filesRoot,
    events,
    messageBox,
    open: filesOpen && !settingsOpen,
    onClose: () => setFilesOpen(false),
  });
  const agentActions: AgentActions = {
    onShow: (agentId) => {
      setInspectedAgent(agentId);
      setInspectorOpen(true);
      setFilesOpen(false);
    },
    onMessageLead: () => composerInput.current?.focus(),
    onInterrupt: (agentId) => void attempt(interrupt({ payload: { agentId: agentId as AgentId } })),
    onStop: (agentId) => void attempt(stop({ payload: { agentId: agentId as AgentId } })),
  };
  const answerApproval: AnswerApproval = (agentId, requestId, decision, scope) =>
    void attempt(respond({ payload: { agentId: agentId as AgentId, requestId, decision, scope } }));
  const answerSpawn: AnswerSpawn = (requestId, decision) =>
    void attempt(resolveSpawn({ payload: { requestId, decision } }));
  /**
   * Opens a blank new thread in this mode, ready to type the first message. A blank one the user wrote
   * in stays in the sidebar as a draft; an empty one is replaced, forgetting what was picked in it.
   */
  const startNew = () => {
    setSettingsOpen(false);
    const drafts = registry.get(draftsAtom);
    if (!hasContent(drafts[blank[mode]])) registry.set(draftsAtom, withoutDraft(drafts, blank[mode]));
    setBlank((current) => ({ ...current, [mode]: newDraftKey() }));
    setOpenThread((current) => ({ ...current, [mode]: undefined }));
    composerInput.current?.focus();
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

  /** Throws a draft away; when it was open, a blank new thread takes its place. */
  const discardDraft = (key: string) => {
    const drafts = registry.get(draftsAtom);
    for (const attachment of drafts[key]?.attachments ?? []) {
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    }
    registry.set(draftsAtom, withoutDraft(drafts, key));
    if (openThread[mode] === key) setOpenThread((current) => ({ ...current, [mode]: undefined }));
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
    if (!settingsOpen && !compact) composerInput.current?.focus();
  }, [settingsOpen, compact]);

  const chooseFolder = (picked: string) => {
    setFolder(picked);
    remember(folderKey, picked);
  };

  const toggleSidebar = () => {
    remember(SIDEBAR_KEY, sidebarOpen ? "hidden" : "shown");
    setSidebarOpen(!sidebarOpen);
  };

  // The shortcuts the window's buttons advertise in their tooltips.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    // Esc backs out of settings, unless something inside them (an open menu) already used it.
    if (event.key === "Escape" && settingsOpen && !event.defaultPrevented) {
      setSettingsOpen(false);
      return;
    }
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    // Search has the keys while it's open, but for Ctrl K, which closes it.
    if (searchOpen && event.key.toLowerCase() !== "k") return;
    if (event.shiftKey) {
      if (event.key.toLowerCase() !== "e" || settingsOpen || filesRoot === undefined) return;
      toggleFiles();
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
      case "1":
      case "2":
        setSettingsOpen(false);
        setMode(event.key === "1" ? "work" : "chat");
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

  const startThread = async (message: OutgoingMessage, setup: ThreadSetup) => {
    const { thread, lead: newLead } = await create({
      payload: {
        title: (message.text.split("\n")[0] || message.attachments[0]?.name || "New thread").slice(0, 80),
        mode,
        ...(mode === "work" && newFolder ? { cwd: newFolder } : {}),
        lead: setup,
      },
    });
    setOpenThread((current) => ({ ...current, [mode]: thread.id }));
    refreshThreads();
    await send({ payload: { agentId: newLead.id, ...message } });
  };

  return (
    <AppFrame
      {...(viewed
        ? {
            thread: {
              title: viewed.thread.title,
              ...(viewed.thread.cwd ? { project: baseName(viewed.thread.cwd) } : {}),
            },
          }
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
          selectedId={viewed?.thread.id ?? openDraft}
          onSelectDraft={openNewDraft}
          onDiscardDraft={discardDraft}
          draftMachine={(machine) =>
            machine === undefined || machine === thisComputer
              ? undefined
              : { name: nameOf(machine), online: deviceOf(machine)?.online === true }
          }
          onSelect={(threadId) => {
            const summary = summaries.find((candidate) => candidate.id === threadId);
            if (summary) openSummary(summary);
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
          // Archiving the open thread leaves it for a new one.
          onArchive={(threadId) =>
            void attempt(setArchived({ payload: { threadId: threadId as ThreadId, archived: true } })).then(
              (archived) => {
                if (!archived) return;
                refreshThreads();
                if (threadId === selected?.thread.id) startNew();
              },
            )
          }
          onRestore={(threadId) =>
            void attempt(setArchived({ payload: { threadId: threadId as ThreadId, archived: false } })).then(
              (restored) => {
                if (restored) refreshThreads();
              },
            )
          }
          // Deleting the open thread leaves it for a new one.
          onDelete={(threadId) =>
            void attempt(remove({ payload: { threadId: threadId as ThreadId } })).then((deleted) => {
              if (!deleted) return;
              registry.set(draftsAtom, withoutDraft(registry.get(draftsAtom), threadId));
              refreshThreads();
              if (threadId === selected?.thread.id) startNew();
            })
          }
          harnesses={indicators}
          onOpenSettings={openSettings}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          messageSearch={
            drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= THREAD_SEARCH_VERSION
          }
        />
      }
      machinePicker={<MachinePicker account={account} />}
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
      inspector={
        inspectorOpen && selected ? (
          <Inspector
            agents={agents}
            selectedId={inspectedAgent}
            onSelect={setInspectedAgent}
            onClose={() => setInspectorOpen(false)}
            onMessageLead={() => composerInput.current?.focus()}
            onInterrupt={(agentId) => attempt(interrupt({ payload: { agentId: agentId as AgentId } }))}
            onStop={(agentId) => attempt(stop({ payload: { agentId: agentId as AgentId } }))}
            onAnswerApproval={answerApproval}
            onAnswerSpawn={answerSpawn}
          />
        ) : undefined
      }
      onToggleInspector={toggleInspector}
      onCloseInspector={() => setInspectorOpen(false)}
      files={inspectorOpen && selected ? undefined : explorer.panel}
      filesAvailable={filesRoot !== undefined}
      filesOpen={filesOpen}
      onToggleFiles={toggleFiles}
      onCloseFiles={() => setFilesOpen(false)}
      filePreviewOpen={explorer.previewing}
      onCloseFilePreview={explorer.closePreview}
    >
      <div className="relative flex h-full flex-col">
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
        <DeviceRequestNotice account={account} onReview={() => openSettings("account")} />
        {WEB ? null : <UpdateNotice />}
        {actionError ? (
          <Notice tone="error" clamp onDismiss={() => setActionError(undefined)}>
            {actionError}
          </Notice>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {viewed && lead ? (
            <Transcript
              key={viewed.thread.id}
              folder={viewed.thread.cwd}
              blocks={buildTranscript(
                leadEvents,
                (a, b) =>
                  a === b || modelLabel(models, lead.provider, a) === modelLabel(models, lead.provider, b),
              )}
              queued={queuedMessages(leadEvents)}
              agent={{ provider: lead.provider, model: leadModel }}
              modelName={(model) => modelLabel(models, lead.provider, model)}
              {...(cloudSelected ? {} : { messageBox })}
              activity={leadRunning ? "running" : leadEnded ? "ended" : "idle"}
              bottomInset={composerHeight}
              childState={(childId) => {
                const child = agents.find((agent) => agent.id === childId);
                return child?.awaitingApproval
                  ? "needsYou"
                  : child?.state === "running" || child?.state === "queued"
                    ? "running"
                    : child?.state === "failed"
                      ? "failed"
                      : "idle";
              }}
              childAgent={(childId) => agents.find((agent) => agent.id === childId)}
              // A thread read from the cloud copy offers no agent actions: they take its machine.
              agentActions={cloudSelected ? {} : agentActions}
              onAnswerPermission={(requestId, decision, scope) =>
                cloudSelected
                  ? Promise.resolve(false)
                  : attempt(respond({ payload: { agentId: lead.id, requestId, decision, scope } }))
              }
            />
          ) : loadingThread ? null : (
            <EmptyThread mode={mode} {...(noHarness ? { onSetUp: () => openSettings("harnesses") } : {})} />
          )}
          {/* An open file covers the conversation but not the message box, which can mention it. */}
          {explorer.overlay ? (
            <div className="absolute inset-x-0 top-0 z-10" style={{ bottom: composerHeight }}>
              {explorer.overlay}
            </div>
          ) : null}
        </div>

        {WEB && driven === undefined && !cloudSelected ? (
          <NoComputerBar />
        ) : loadingThread ? (
          <LoadingThreadBar />
        ) : cloudSelected && !(cloudConnecting && lead) ? (
          <CloudThreadBar
            machine={nameOf(cloudSelected.machine)}
            reach={cloudDevice ? reachOf(cloudDevice) : { kind: "offline", presence: "Not connected" }}
            connecting={cloudSelected.machine === drivenId}
            onOpen={() => {
              if (cloudDevice) openOn(cloudDevice, cloudSelected.overview.thread.id);
            }}
            onStartNew={startNew}
          />
        ) : (
          // While the open thread's machine is still connecting, the box keeps its draft and takes
          // writing; sending waits until the machine answers.
          <Composer
            draftKey={viewed && lead ? viewed.thread.id : openDraft}
            connecting={cloudSelected !== undefined}
            inputRef={composerInput}
            messageBox={messageBoxRef}
            target={
              viewed && lead
                ? {
                    kind: "thread",
                    provider: lead.provider,
                    model: leadModel,
                    modelId: lead.model,
                    effort: lead.effort,
                    folder: viewed.thread.cwd,
                    ...(leadEnded ? { ended: leadEnded } : {}),
                    // A thread read from the cloud copy can't be switched: it takes its machine.
                    ...(cloudSelected
                      ? {}
                      : {
                          onSwitch: (choice) =>
                            attempt(switchLead({ payload: { agentId: lead.id, ...choice } })),
                        }),
                  }
                : { kind: "new", mode, folder: newFolder, onChooseFolder: chooseFolder, available }
            }
            running={leadRunning && cloudSelected === undefined}
            above={
              cloudSelected ? (
                <ConnectingNote machine={nameOf(cloudSelected.machine)} />
              ) : (
                <ApprovalTray agents={agents} onAnswer={answerApproval} onAnswerSpawn={answerSpawn} />
              )
            }
            onHeight={setComposerHeight}
            onSend={(message, setup) =>
              attempt(
                selected && lead
                  ? send({ payload: { agentId: lead.id, ...message } })
                  : startThread(message, setup),
              )
            }
            onStop={() => {
              if (lead) void attempt(interrupt({ payload: { agentId: lead.id } }));
            }}
          />
        )}
      </div>
    </AppFrame>
  );
}
