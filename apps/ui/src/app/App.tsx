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
import { Cause } from "effect";
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
  respondToPermission,
  sendMessage,
  setThreadArchived,
  stopAgent,
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
  useAccountPresence,
  useShellPresence,
} from "../features/account/AccountNotice.tsx";
import { MachinePicker } from "../features/account/MachinePicker.tsx";
import { presenceLabel, reachOf } from "../features/account/model.ts";
import { type AgentActions } from "../features/agents/AgentMenu.tsx";
import { ApprovalTray, type AnswerApproval } from "../features/agents/ApprovalTray.tsx";
import { Inspector } from "../features/agents/Inspector.tsx";
import { Composer, type OutgoingMessage, type ThreadSetup } from "../features/composer/Composer.tsx";
import { useMessageBoxHandle } from "../features/composer/messageBox.ts";
import { useModels } from "../features/composer/models.ts";
import { themeAtom } from "../features/settings/preferences.ts";
import {
  settingsLabel,
  SettingsNav,
  SettingsView,
  type SettingsCategory,
} from "../features/settings/Settings.tsx";
import { useTheme } from "../features/settings/theme.ts";
import { CloudThreadBar, NoComputerBar } from "../features/threads/CloudThread.tsx";
import { useReadState } from "../features/threads/readState.ts";
import type { ThreadSummary } from "../features/threads/model.ts";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { buildTranscript, queuedMessages } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { remember, stored } from "../lib/storage.ts";
import { useNotificationOpens, useRenewPush } from "../web/push.ts";
import { WebGate } from "../web/WebGate.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { useCompact } from "./compact.ts";
import { EmptyThread } from "./EmptyThread.tsx";
import type { AppMode } from "./ModeSwitch.tsx";
import { Notice } from "./Notice.tsx";
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
  const [mode, setMode] = useState<AppMode>("work");
  /** The open thread per mode; none means "start a new one". */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** The agent the inspector shows; the lead until another is picked. */
  const [inspectedAgent, setInspectedAgent] = useState<string>();
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  const folderKey = machineKey(FOLDER_KEY, driven);
  const [folder, setFolder] = useState(() => stored(folderKey));
  // Switching machines starts afresh there: its last folder, and no thread open from the other one.
  const [shownFolderKey, setShownFolderKey] = useState(folderKey);
  /** A thread on another machine the user opened, which opens once the window drives that machine. */
  const [openAfterSwitch, setOpenAfterSwitch] = useState<{ readonly mode: AppMode; readonly id: string }>();
  if (shownFolderKey !== folderKey) {
    setShownFolderKey(folderKey);
    setFolder(stored(folderKey));
    setOpenThread(openAfterSwitch ? { [openAfterSwitch.mode]: openAfterSwitch.id } : {});
    setOpenAfterSwitch(undefined);
  }
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const [actionError, setActionError] = useState<string>();
  /** How tall the approval tray above the message box is, so the transcript's end stays visible. */
  const [trayHeight, setTrayHeight] = useState(0);
  /** How much taller files attached to the draft make the message box, for the same reason. */
  const [attachmentsHeight, setAttachmentsHeight] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const compact = useCompact();
  /** The narrow window's pane (§14.10): the threads, or the open (or new) thread. */
  const [pane, setPane] = useState<"list" | "main">("list");
  /** Its settings pane: the categories, or the open category's page. */
  const [settingsPane, setSettingsPane] = useState<"nav" | "page">("nav");
  /** The category settings open on: the last one visited. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const composerInput = useRef<HTMLDivElement>(null);
  const [messageBoxRef, messageBox] = useMessageBoxHandle();

  const connection = useAtomValue(connectionAtom);
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnesses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);
  const models = useModels();
  // Another machine that can't be reached shows the threads it last listed no more: they read from
  // the cloud copy instead, until it answers again. This computer's own list stays while it reconnects.
  const live =
    AsyncResult.isSuccess(threadsResult) && !(connection === "unreachable" && driven !== undefined);
  const overviews = live ? AsyncResult.getOrElse(threadsResult, (): ReadonlyArray<ThreadOverview> => []) : [];
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), (): AccountState => ({
    _tag: "SignedOut",
  }));
  const accountThreads = AsyncResult.getOrElse(useAtomValue(accountThreadsAtom), (): AccountThreads => ({
    threads: [],
    read: [],
  }));
  // Every thread of the account (§14.9): the driven machine's live, the others' from the cloud copy.
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
  // The web client always drives one of the account's desktops (§14.10): the one it drove last,
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
  /** Opens another machine's thread there: the window drives that machine, then shows it. */
  const openOn = (device: DeviceInfo, threadId: string, threadMode: AppMode = mode) => {
    setOpenAfterSwitch({ mode: threadMode, id: threadId });
    setPane("main");
    driveMachine(registry, device.id === thisComputer ? undefined : { id: device.id, name: device.name });
  };
  /** Opens a thread of the inbox: another machine's there when it can, else here (read-only when it's another's). */
  const openSummary = (summary: ThreadSummary) => {
    setHeldUnread(summary.unread ? summary.id : undefined);
    const home = summary.elsewhere ? deviceOf(summary.elsewhere.machine) : undefined;
    if (home && home.id !== drivenId && (home.id === thisComputer || reachOf(home).kind === "reachable")) {
      openOn(home, summary.id, summary.mode);
      return;
    }
    setOpenThread((current) => ({ ...current, [summary.mode]: summary.id }));
    setPane("main");
  };

  // A tapped notification (§14.11) opens its thread, once the inbox lists it.
  useNotificationOpens(
    (threadId) => summaries.find((summary) => summary.id === threadId),
    (summary) => {
      setSettingsOpen(false);
      setMode(summary.mode);
      openSummary(summary);
    },
  );
  useRenewPush(account);
  // Nobody is told about the thread this window shows (§14.11), unless settings or the narrow
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
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
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
    return { provider, state: status.auth._tag === "LoggedIn" ? "ready" : "loggedOut" };
  });
  const available = new Set(
    indicators.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])),
  );

  const lead = viewed ? leadOf(viewed.agents) : undefined;
  const agents = viewed ? toAgentSummaries(viewed.agents, events, models) : [];
  const leadModel =
    agents.find((agent) => agent.id === lead?.id)?.model ??
    (lead ? modelLabel(models, lead.provider, lead.model) : "");
  const leadRunning = lead?.state === "running" || lead?.state === "queued";
  // An ended lead picks the thread back up on the user's next message.
  const leadEnded = lead?.state === "stopped" || lead?.state === "failed" ? lead.state : undefined;
  const leadEvents = lead ? events.filter((event) => event.agentId === lead.id) : [];
  const agentActions: AgentActions = {
    onShow: (agentId) => {
      setInspectedAgent(agentId);
      setInspectorOpen(true);
    },
    onMessageLead: () => composerInput.current?.focus(),
    onInterrupt: (agentId) => void attempt(interrupt({ payload: { agentId: agentId as AgentId } })),
    onStop: (agentId) => void attempt(stop({ payload: { agentId: agentId as AgentId } })),
  };
  const answerApproval: AnswerApproval = (agentId, requestId, decision, scope) =>
    void attempt(respond({ payload: { agentId: agentId as AgentId, requestId, decision, scope } }));
  /** Opens this mode's new thread, ready to type the first message. */
  const startNew = () => {
    setSettingsOpen(false);
    setOpenThread((current) => ({ ...current, [mode]: undefined }));
    composerInput.current?.focus();
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
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
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
      case "j":
        if (selected === undefined || settingsOpen) return;
        setInspectorOpen((open) => !open);
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
        ...(mode === "work" && folder ? { cwd: folder } : {}),
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
          selectedId={viewed?.thread.id}
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
              refreshThreads();
              if (threadId === selected?.thread.id) startNew();
            })
          }
          harnesses={indicators}
          onOpenSettings={openSettings}
        />
      }
      machinePicker={<MachinePicker account={account} />}
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
        page: <SettingsView category={settingsCategory} harnesses={indicators} />,
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
          />
        ) : undefined
      }
      onToggleInspector={() => setInspectorOpen((open) => !open)}
    >
      <div className="relative flex h-full flex-col">
        {connection === "unreachable" && driven !== undefined ? (
          <Notice tone="attention">
            Can't reach {driven.name}
            {drivenDevice && !drivenDevice.online ? ` (${presenceLabel(drivenDevice).toLowerCase()})` : ""}.
            Cerium keeps trying.
            {WEB ? null : (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => driveMachine(registry, undefined)}
                  className="font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
                >
                  Back to this computer
                </button>
              </>
            )}
          </Notice>
        ) : connection === "unreachable" && !WEB ? (
          <Notice tone="attention">
            Reconnecting to Cerium's backend…
            {import.meta.env.DEV ? (
              <>
                {" "}
                In development, <code>bun run dev</code> starts it.
              </>
            ) : null}
          </Notice>
        ) : AsyncResult.isFailure(threadsResult) ? (
          <Notice tone="error">{messageOf(Cause.squash(threadsResult.cause))}</Notice>
        ) : null}
        <DeviceRequestNotice account={account} onReview={() => openSettings("account")} />
        {WEB ? null : <UpdateNotice onOpenSettings={() => openSettings("updates")} />}
        {actionError ? (
          <Notice tone="error" onDismiss={() => setActionError(undefined)}>
            {actionError}
          </Notice>
        ) : null}

        <div className="min-h-0 flex-1">
          {viewed && lead ? (
            <Transcript
              key={viewed.thread.id}
              folder={viewed.thread.cwd}
              blocks={buildTranscript(leadEvents)}
              queued={queuedMessages(leadEvents)}
              agent={{ provider: lead.provider, model: leadModel }}
              {...(cloudSelected ? {} : { messageBox })}
              activity={leadRunning ? "running" : leadEnded ? "ended" : "idle"}
              bottomInset={trayHeight + attachmentsHeight}
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
          ) : (
            <EmptyThread mode={mode} folder={folder} />
          )}
        </div>

        {WEB && driven === undefined && !cloudSelected ? (
          <NoComputerBar />
        ) : cloudSelected ? (
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
          <Composer
            draftKey={selected ? selected.thread.id : `new:${mode}`}
            inputRef={composerInput}
            messageBox={messageBoxRef}
            target={
              selected && lead
                ? {
                    kind: "thread",
                    provider: lead.provider,
                    model: leadModel,
                    folder: selected.thread.cwd,
                    ...(leadEnded ? { ended: leadEnded } : {}),
                  }
                : { kind: "new", mode, folder, onChooseFolder: chooseFolder, available }
            }
            running={leadRunning}
            above={<ApprovalTray agents={agents} onAnswer={answerApproval} onHeight={setTrayHeight} />}
            onAttachmentsHeight={setAttachmentsHeight}
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
