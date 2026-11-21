import { type AgentId } from "@cerium/protocol";
import { FORK_THREAD_RPC_VERSION, PER_FILE_TURN_REVERT_RPC_VERSION, RPC_VERSION } from "@cerium/rpc";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";

import {
  compactAgent,
  stopBackgroundTask,
  askSideQuestion,
  suggestFollowup,
  createThread,
  editMessage,
  forkThread,
  previewForkThread,
  interruptAgent,
  previewRestore,
  resolveSpawnApproval,
  restoreBefore,
  respondToPermission,
  steerAgent,
  withdrawMessage,
  answerQuestion,
  sendMessage,
  setThreadOnLimit,
  stopAgent,
  stopThread,
  switchModel,
  handOffLead,
} from "../backend/atoms.ts";
import { machineAtom } from "../backend/machine.ts";
import { type AgentActions } from "../features/agents/AgentMenu.tsx";
import {
  type AnswerApproval,
  type AnswerQuestion,
  type AnswerSpawn,
} from "../features/agents/ApprovalTray.tsx";
import { STOP_THREAD_VERSION, stopAllScope } from "../features/agents/model.ts";
import { StopAllDialog } from "../features/agents/StopAllDialog.tsx";
import type { OutgoingMessage, ThreadSetup } from "../features/composer/Composer.tsx";
import { HANDOFF_VERSION, LIMIT_POLICY_VERSION } from "../features/composer/models.ts";
import { linkTaskThreads, tasksAtom } from "../features/tasks/tasks.ts";
import { SCRIPT_BOOT_VERSION } from "../features/terminal/model.ts";
import { autocompleteAtom } from "../features/settings/preferences.ts";
import { type SettingsCategory } from "../features/settings/Settings.tsx";
import {
  EDIT_VERSION,
  SIDE_QUESTION_VERSION,
  STEER_VERSION,
  WITHDRAW_VERSION,
} from "../features/transcript/model.ts";
import { RESTORE_VERSION } from "../features/transcript/restore.ts";
import { STOP_BACKGROUND_VERSION } from "../features/composer/BackgroundTray.tsx";
import { FOLLOWUP_VERSION } from "../features/composer/followup.ts";
import { revertTurnFiles, TURN_FILES_VERSION } from "../backend/turnFiles.ts";
import { layoutOf, paneShowing, renameKey, singlePane, spreadBeside } from "../features/split/model.ts";
import { MIN_PANE } from "../features/split/SplitView.tsx";
import { type ThreadPaneActions } from "./ThreadPane.tsx";

import type { DrivenMachine } from "../backend/machine.ts";
import type { WorkspaceSession } from "./useWorkspaceSession.ts";
import { MAIN_PANE, newPaneId } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";
import type { WorkspacePanels } from "./useWorkspacePanels.ts";
import type { WorkspaceTools } from "./useWorkspaceTools.tsx";
import { messageOf, type useWorkspaceErrors } from "./workspaceErrors.ts";

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

export function useThreadPaneActions({
  driven,
  compact,
  sessionState,
  threads,
  tabView,
  composer,
  panels,
  tools,
  errors,
  settingsOpen,
  searchOpen,
  welcoming,
  openSettings,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly compact: boolean;
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly composer: WorkspaceComposer;
  readonly panels: WorkspacePanels;
  readonly tools: WorkspaceTools;
  readonly errors: ReturnType<typeof useWorkspaceErrors>;
  readonly settingsOpen: boolean;
  readonly searchOpen: boolean;
  readonly welcoming: boolean;
  readonly openSettings: (category?: SettingsCategory) => void;
}) {
  const registry = useContext(RegistryContext);
  const { mode, blank, setOpenThread, setPanesByMode, setPane, chooseFolder } = sessionState;
  const { drivenDevice, connection, refreshThreads, agents, selected, cloudSelected, noHarness } = threads;
  const { tabs, panesArea } = tabView;
  const { openKey, focusComposer } = composer;
  const { setInspectedAgent, setSidePanel } = panels;
  const { openTurnFile } = tools;
  const { attempt, setActionError } = errors;
  const create = useAtomSet(createThread, { mode: "promise" });
  const fork = useAtomSet(forkThread, { mode: "promise" });
  const checkFork = useAtomSet(previewForkThread, { mode: "promise" });
  const send = useAtomSet(sendMessage, { mode: "promise" });
  const edit = useAtomSet(editMessage, { mode: "promise" });
  const checkRestore = useAtomSet(previewRestore, { mode: "promise" });
  const restore = useAtomSet(restoreBefore, { mode: "promise" });
  const revertTurn = useAtomSet(revertTurnFiles, { mode: "promise" });
  const switchLead = useAtomSet(switchModel, { mode: "promise" });
  const compactLead = useAtomSet(compactAgent, { mode: "promise" });
  const stopBackground = useAtomSet(stopBackgroundTask, { mode: "promise" });
  const setOnLimit = useAtomSet(setThreadOnLimit, { mode: "promise" });
  const askSide = useAtomSet(askSideQuestion, { mode: "promise" });
  const suggest = useAtomSet(suggestFollowup, { mode: "promise" });
  const autocomplete = useAtomValue(autocompleteAtom);
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
  const canSteer = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= STEER_VERSION;
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
    taskId: string | undefined,
  ) => {
    const title = (message.text.split("\n")[0] || message.attachments[0]?.name || "New thread").slice(0, 80);
    // The threads of one multi-agent run share an id, so the sidebar shows them as one.
    const runId = setups.length > 1 ? crypto.randomUUID() : undefined;
    const created = await settleInTurn(setups, ({ worktree, workspace, ...lead }) =>
      create({
        payload: {
          title,
          mode,
          ...(mode === "work" && newFolder ? { cwd: newFolder } : {}),
          ...(worktree ? { worktree } : {}),
          ...(workspace ? { workspace } : {}),
          ...(runId ? { runId } : {}),
          lead,
        },
      }),
    );
    const started = created.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const [first, ...others] = started;
    if (first === undefined) throw (created[0] as PromiseRejectedResult).reason;
    if (taskId !== undefined) {
      const taskStore = registry.get(tasksAtom);
      const linked = linkTaskThreads(
        taskStore,
        taskId,
        started.map(({ thread }) => thread.id),
        Date.now(),
        newFolder,
      );
      if (linked !== taskStore) registry.set(tasksAtom, linked);
    }
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

  /** The machine keeps threads' workspaces: their checkouts, links and reviews. */
  const workspacesOk = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= 48;
  const paneActions: ThreadPaneActions = {
    sourceControlEnabled: workspacesOk,
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
    fork:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= FORK_THREAD_RPC_VERSION
        ? {
            preview: (threadId, turn) => checkFork({ payload: { threadId, turn } }),
            fork: async (threadId, { turn, ...choice }) => {
              // Rejects with the backend's reason, which the fork dialog says in place.
              const { thread } = await fork({ payload: { threadId, turn, ...choice } });
              refreshThreads();
              // The sibling opens where this thread is, in its own mode.
              setOpenThread((open) => ({ ...open, [thread.mode]: thread.id }));
              setPane("main");
            },
          }
        : undefined,
    turnFiles:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= TURN_FILES_VERSION
        ? {
            open: openTurnFile,
            perFile:
              drivenDevice === undefined ||
              (drivenDevice.rpcVersion ?? 0) >= PER_FILE_TURN_REVERT_RPC_VERSION,
            revert: (agentId, turnId, direction, paths) =>
              revertTurn({
                payload: { agentId, turnId, direction, ...(paths === undefined ? {} : { paths }) },
              }),
          }
        : undefined,
    start: startThread,
    interrupt: (agentId) => interrupt({ payload: { agentId } }),
    steer: canSteer
      ? (agentId) =>
          registry.get(machineAtom)?.id === driven?.id ? steer({ payload: { agentId } }) : Promise.resolve()
      : undefined,
    withdraw:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= WITHDRAW_VERSION
        ? (agentId, messageId) => withdraw({ payload: { agentId, messageId } })
        : undefined,
    switchLead: (agentId, choice) => switchLead({ payload: { agentId, ...choice } }),
    compact: (agentId) => compactLead({ payload: { agentId } }),
    stopBackground:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= STOP_BACKGROUND_VERSION
        ? (agentId, taskId) => stopBackground({ payload: { agentId, taskId } })
        : undefined,
    setOnLimit:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= LIMIT_POLICY_VERSION
        ? (threadId, policy) =>
            setOnLimit({ payload: { threadId, policy } }).then((thread) => {
              refreshThreads();
              return thread;
            })
        : undefined,
    askSide:
      drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= SIDE_QUESTION_VERSION
        ? (agentId, question, earlier) => askSide({ payload: { agentId, question, earlier } })
        : undefined,
    // This computer's own backend ships with the window; another machine that doesn't say is unavailable.
    suggestFollowup:
      autocomplete === "on" &&
      !settingsOpen &&
      !searchOpen &&
      !welcoming &&
      connection === "connected" &&
      (driven === undefined ? RPC_VERSION : (drivenDevice?.rpcVersion ?? 0)) >= FOLLOWUP_VERSION
        ? (threadId, agentId, afterSeq) => suggest({ payload: { threadId, agentId, afterSeq } })
        : undefined,
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
    confirmsSetup: drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= SCRIPT_BOOT_VERSION,
    onSetUp: noHarness ? () => openSettings("harnesses") : undefined,
    chooseFolder,
  };

  const stopAllDialog = selected ? (
    <StopAllDialog
      scope={stopScope}
      open={stopAllOpen && canStopAll}
      onOpenChange={setStopAllOpen}
      onConfirm={() => void attempt(stopEverything({ payload: { threadId: selected.thread.id } }))}
    />
  ) : null;

  return {
    paneActions,
    workspacesOk,
    canSteer,
    askStopAll,
    canStopAll,
    stopAllDialog,
    answerApproval,
    answerSpawn,
    answerQuestionOf,
    interruptFromInspector: (agentId: string) =>
      attempt(interrupt({ payload: { agentId: agentId as AgentId } })),
    stopFromInspector: (agentId: string) => attempt(stop({ payload: { agentId: agentId as AgentId } })),
  };
}

export type WorkspacePaneActions = ReturnType<typeof useThreadPaneActions>;
