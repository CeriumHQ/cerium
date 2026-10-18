import type { AgentEvent, AgentId, ProviderId, ThreadId } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  createThread,
  harnessesAtom,
  interruptAgent,
  renameThread,
  respondToPermission,
  sendMessage,
  setThreadArchived,
  stopAgent,
  threadEventsAtom,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { saveProject } from "../backend/projects.ts";
import { leadOf, modelLabel, toAgentSummaries, toThreadSummary } from "../backend/view.ts";
import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { type AgentActions } from "../features/agents/AgentMenu.tsx";
import { ApprovalTray, type AnswerApproval } from "../features/agents/ApprovalTray.tsx";
import { Inspector } from "../features/agents/Inspector.tsx";
import { Composer, type OutgoingMessage, type ThreadSetup } from "../features/composer/Composer.tsx";
import { useMessageBoxHandle } from "../features/composer/messageBox.ts";
import { useModels } from "../features/composer/models.ts";
import { themeAtom } from "../features/settings/preferences.ts";
import { SettingsNav, SettingsView, type SettingsCategory } from "../features/settings/Settings.tsx";
import { useTheme } from "../features/settings/theme.ts";
import { useReadState } from "../features/threads/readState.ts";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { buildTranscript } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { remember, stored } from "../lib/storage.ts";
import { AppFrame } from "./AppFrame.tsx";
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
        <Workspace />
        <TextMenu />
      </TooltipProvider>
    </RegistryProvider>
  );
}

function Workspace() {
  const [mode, setMode] = useState<AppMode>("work");
  /** The open thread per mode; none means "start a new one". */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** The agent the inspector shows; the lead until another is picked. */
  const [inspectedAgent, setInspectedAgent] = useState<string>();
  const [folder, setFolder] = useState(() => stored(FOLDER_KEY));
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const [actionError, setActionError] = useState<string>();
  /** How tall the approval tray above the message box is, so the transcript's end stays visible. */
  const [trayHeight, setTrayHeight] = useState(0);
  /** How much taller files attached to the draft make the message box, for the same reason. */
  const [attachmentsHeight, setAttachmentsHeight] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The category settings open on: the last one visited. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const composerInput = useRef<HTMLDivElement>(null);
  const [messageBoxRef, messageBox] = useMessageBoxHandle();

  useTheme(useAtomValue(themeAtom));

  const connection = useAtomValue(connectionAtom);
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnesses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);
  const models = useModels();
  const overviews = AsyncResult.getOrElse(threadsResult, (): ReadonlyArray<ThreadOverview> => []);
  const selected = overviews.find(
    (overview) => overview.thread.id === openThread[mode] && overview.thread.mode === mode,
  );
  const readState = useReadState();
  /** The open thread, when it was unread as the user opened it: it keeps its inbox place until they leave. */
  const [heldUnread, setHeldUnread] = useState<string>();
  // A work thread is unread once it changed after the user last saw it; the open one is seen as it changes.
  const summaries = overviews
    .map(toThreadSummary)
    .map((summary) =>
      summary.mode !== "work"
        ? summary
        : summary.id === selected?.thread.id
          ? { ...summary, unread: summary.id === heldUnread }
          : { ...summary, unread: readState.isUnread(summary.id, summary.updatedAt) },
    );
  const selectedSummary = summaries.find((summary) => summary.id === selected?.thread.id);
  const markSeen = useEffectEvent(() => {
    if (selectedSummary && readState.isUnread(selectedSummary.id, selectedSummary.updatedAt)) {
      readState.markRead([selectedSummary]);
    }
  });
  useEffect(() => markSeen(), [selectedSummary?.id, selectedSummary?.updatedAt]);
  const events = AsyncResult.getOrElse(
    useAtomValue(selected ? threadEventsAtom(selected.thread.id) : noEvents),
    (): ReadonlyArray<AgentEvent> => [],
  );

  const create = useAtomSet(createThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
  const interrupt = useAtomSet(interruptAgent, { mode: "promise" });
  const stop = useAtomSet(stopAgent, { mode: "promise" });
  const rename = useAtomSet(renameThread, { mode: "promise" });
  const setArchived = useAtomSet(setThreadArchived, { mode: "promise" });
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

  const lead = selected ? leadOf(selected.agents) : undefined;
  const agents = selected ? toAgentSummaries(selected.agents, events, models) : [];
  const leadModel =
    agents.find((agent) => agent.id === lead?.id)?.model ??
    (lead ? modelLabel(models, lead.provider, lead.model) : "");
  const leadRunning = lead?.state === "running" || lead?.state === "queued";
  const leadEnded = lead?.state === "stopped" || lead?.state === "failed" ? lead.state : undefined;
  // A lead whose harness session started can be resumed by messaging it.
  const leadResumable = lead?.providerSessionId !== undefined;
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

  const openSettings = (category?: SettingsCategory) => {
    if (category) setSettingsCategory(category);
    setSettingsOpen(true);
  };
  // Back from settings, the cursor returns to the message box.
  useEffect(() => {
    if (!settingsOpen) composerInput.current?.focus();
  }, [settingsOpen]);

  const chooseFolder = (picked: string) => {
    setFolder(picked);
    remember(FOLDER_KEY, picked);
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
        startNew();
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
      {...(selected
        ? {
            thread: {
              title: selected.thread.title,
              ...(selected.thread.cwd ? { project: baseName(selected.thread.cwd) } : {}),
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
      onNewThread={startNew}
      sidebar={
        <Sidebar
          mode={mode}
          threads={summaries}
          selectedId={selected?.thread.id}
          onSelect={(threadId) => {
            const summary = summaries.find((candidate) => candidate.id === threadId);
            setHeldUnread(summary?.unread ? threadId : undefined);
            setOpenThread((current) => ({ ...current, [mode]: threadId }));
          }}
          onNewThread={startNew}
          onMarkRead={(threads) => {
            if (threads.some((thread) => thread.id === heldUnread)) setHeldUnread(undefined);
            readState.markRead(threads);
          }}
          onMarkUnread={(threadId) => {
            if (threadId === selected?.thread.id) setHeldUnread(threadId);
            readState.markUnread(threadId);
          }}
          onNewThreadIn={(picked) => {
            chooseFolder(picked);
            void save({ payload: { path: picked } }).catch(() => undefined);
            startNew();
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
          harnesses={indicators}
          onOpenSettings={openSettings}
        />
      }
      settings={{
        open: settingsOpen,
        nav: (
          <SettingsNav
            category={settingsCategory}
            onSelect={setSettingsCategory}
            backLabel={mode === "work" ? "Back to threads" : "Back to chats"}
            onBack={() => setSettingsOpen(false)}
            active={settingsOpen}
          />
        ),
        page: <SettingsView category={settingsCategory} harnesses={indicators} />,
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
        {connection === "unreachable" ? (
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
        {actionError ? (
          <Notice tone="error" onDismiss={() => setActionError(undefined)}>
            {actionError}
          </Notice>
        ) : null}

        <div className="min-h-0 flex-1">
          {selected && lead ? (
            <Transcript
              key={selected.thread.id}
              folder={selected.thread.cwd}
              blocks={buildTranscript(events.filter((event) => event.agentId === lead.id))}
              agent={{ provider: lead.provider, model: leadModel }}
              {...(leadEnded && !leadResumable ? {} : { messageBox })}
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
              agentActions={agentActions}
              onAnswerPermission={(requestId, decision, scope) =>
                attempt(respond({ payload: { agentId: lead.id, requestId, decision, scope } }))
              }
            />
          ) : (
            <EmptyThread mode={mode} folder={folder} />
          )}
        </div>

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
                  ...(leadEnded ? { ended: leadEnded, resumable: leadResumable } : {}),
                  onStartNew: startNew,
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
      </div>
    </AppFrame>
  );
}
