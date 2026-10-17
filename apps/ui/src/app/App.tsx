import type { AgentEvent, AgentId, ProviderId } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  createThread,
  harnessesAtom,
  interruptAgent,
  respondToPermission,
  sendMessage,
  stopAgent,
  threadEventsAtom,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { pickFolder } from "../backend/shell.ts";
import { leadOf, modelLabel, toAgentSummaries, toThreadSummary } from "../backend/view.ts";
import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { Inspector } from "../features/agents/Inspector.tsx";
import { Composer, type ThreadSetup } from "../features/composer/Composer.tsx";
import { Sidebar, type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { buildTranscript } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { EmptyThread } from "./EmptyThread.tsx";
import type { AppMode } from "./ModeSwitch.tsx";
import { Notice } from "./Notice.tsx";

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];
const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));
const FOLDER_KEY = "cerium:lastFolder";
const SIDEBAR_KEY = "cerium:sidebar";

// Remembered window preferences are a convenience only: storage failing must never break the app.
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered this time.
  }
};

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
      </TooltipProvider>
    </RegistryProvider>
  );
}

function Workspace() {
  const [mode, setMode] = useState<AppMode>("work");
  /** The open thread per mode; none means "start a new one". */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [folder, setFolder] = useState(() => stored(FOLDER_KEY));
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const [actionError, setActionError] = useState<string>();
  const composerInput = useRef<HTMLTextAreaElement>(null);

  const connection = useAtomValue(connectionAtom);
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnesses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);
  const overviews = AsyncResult.getOrElse(threadsResult, (): ReadonlyArray<ThreadOverview> => []);
  const selected = overviews.find(
    (overview) => overview.thread.id === openThread[mode] && overview.thread.mode === mode,
  );
  const events = AsyncResult.getOrElse(
    useAtomValue(selected ? threadEventsAtom(selected.thread.id) : noEvents),
    (): ReadonlyArray<AgentEvent> => [],
  );

  const create = useAtomSet(createThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const respond = useAtomSet(respondToPermission, { mode: "promise" });
  const interrupt = useAtomSet(interruptAgent, { mode: "promise" });
  const stop = useAtomSet(stopAgent, { mode: "promise" });
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
  const agents = selected ? toAgentSummaries(selected.agents, events) : [];
  const leadModel =
    agents.find((agent) => agent.id === lead?.id)?.model ?? (lead ? modelLabel(lead.model) : "");
  const leadRunning = lead?.state === "running" || lead?.state === "queued";
  const leadEnded = lead?.state === "stopped" || lead?.state === "failed" ? lead.state : undefined;
  /** Opens this mode's new thread, ready to type the first message. */
  const startNew = () => {
    setOpenThread((current) => ({ ...current, [mode]: undefined }));
    composerInput.current?.focus();
  };

  const chooseFolder = () => {
    void pickFolder().then((picked) => {
      if (picked === undefined) return;
      setFolder(picked);
      remember(FOLDER_KEY, picked);
    });
  };

  const toggleSidebar = () => {
    remember(SIDEBAR_KEY, sidebarOpen ? "hidden" : "shown");
    setSidebarOpen(!sidebarOpen);
  };

  // The shortcuts the window's buttons advertise in their tooltips.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    switch (event.key.toLowerCase()) {
      case "b":
        toggleSidebar();
        break;
      case "n":
        startNew();
        break;
      case "j":
        if (selected === undefined) return;
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

  const startThread = async (text: string, setup: ThreadSetup) => {
    const { thread, lead: newLead } = await create({
      payload: {
        title: text.split("\n")[0]!.slice(0, 80),
        mode,
        ...(mode === "work" && folder ? { cwd: folder } : {}),
        lead: setup,
      },
    });
    setOpenThread((current) => ({ ...current, [mode]: thread.id }));
    refreshThreads();
    await send({ payload: { agentId: newLead.id, text } });
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
      onModeChange={setMode}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      onNewThread={startNew}
      sidebar={
        <Sidebar
          mode={mode}
          threads={overviews.map(toThreadSummary)}
          selectedId={selected?.thread.id}
          onSelect={(threadId) => setOpenThread((current) => ({ ...current, [mode]: threadId }))}
          onNewThread={startNew}
          harnesses={indicators}
        />
      }
      agents={selected ? selected.agents.map((agent) => agent.provider) : []}
      inspector={
        inspectorOpen && selected ? (
          <Inspector
            agents={agents}
            onClose={() => setInspectorOpen(false)}
            onInterrupt={(agentId) => attempt(interrupt({ payload: { agentId: agentId as AgentId } }))}
            onStop={(agentId) => attempt(stop({ payload: { agentId: agentId as AgentId } }))}
          />
        ) : undefined
      }
      onToggleInspector={() => setInspectorOpen((open) => !open)}
    >
      <div className="relative flex h-full flex-col">
        {connection === "unreachable" ? (
          <Notice tone="attention">
            Reconnecting to Cerium's backend… In development, start it with <code>bun run dev:backend</code>.
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
              blocks={buildTranscript(events.filter((event) => event.agentId === lead.id))}
              agent={{ provider: lead.provider, model: leadModel }}
              activity={leadRunning ? "running" : leadEnded ? "ended" : "idle"}
              childState={(childId) => {
                const state = selected.agents.find((agent) => agent.id === childId)?.state;
                return state === "running" || state === "queued"
                  ? "running"
                  : state === "failed"
                    ? "failed"
                    : "idle";
              }}
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
          target={
            selected && lead
              ? {
                  kind: "thread",
                  provider: lead.provider,
                  model: leadModel,
                  ...(leadEnded ? { ended: leadEnded } : {}),
                  onStartNew: startNew,
                }
              : { kind: "new", mode, folder, onPickFolder: chooseFolder, available }
          }
          running={leadRunning}
          onSend={(text, setup) =>
            attempt(
              selected && lead ? send({ payload: { agentId: lead.id, text } }) : startThread(text, setup),
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
