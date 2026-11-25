import { type ThreadId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { reconnectNow } from "../backend/client.ts";
import { machineAtom } from "../backend/machine.ts";
import { saveProject } from "../backend/projects.ts";
import { WEB } from "../backend/target.ts";
import { MachinePicker } from "../features/account/MachinePicker.tsx";
import { presenceLabel, reachOf } from "../features/account/model.ts";
import { SwitchComputerSheet } from "../features/account/SwitchComputerSheet.tsx";
import { hasContent } from "../features/composer/draft.ts";
import { draftsAtom } from "../features/composer/drafts.ts";
import { takeShared } from "../features/composer/shareTarget.ts";
import { Inspector } from "../features/agents/Inspector.tsx";
import { ArtifactsPanel } from "../features/artifacts/ArtifactsPanel.tsx";
import { DraftSync } from "../features/composer/useDraftSync.ts";
import { TaskSync } from "../features/tasks/TaskSync.ts";
import { CommandPalette } from "../features/palette/CommandPalette.tsx";
import {
  CompactWorkspaceSubtitle,
  ThreadLineage,
  WorkspaceStatus,
} from "../features/git/WorkspaceStatus.tsx";
import { settingsLabel, SettingsNav, SettingsView } from "../features/settings/Settings.tsx";
import { ThreadTabs } from "../features/tabs/ThreadTabs.tsx";
import { nextWaitingThread, type ThreadSummary } from "../features/threads/model.ts";
import { NextWaitingPill } from "../features/threads/NextWaitingPill.tsx";
import { Sidebar } from "../features/threads/Sidebar.tsx";
import { MoveToWorkDialog } from "../features/transcript/MoveToWorkDialog.tsx";
import { TriageSheet } from "../features/threads/TriageSheet.tsx";
import { THREAD_SEARCH_VERSION } from "../features/threads/threadSearch.ts";
import { welcomeShownAtom } from "../features/onboarding/state.ts";
import { SplitView } from "../features/split/SplitView.tsx";
import { bindingFor, shortcutBindingsAtom, type ShortcutId } from "../lib/shortcuts.ts";
import { remember, stored } from "../lib/storage.ts";
import { useLaunchRequests } from "../features/launch/launchRequests.ts";
import { AppFrame } from "./AppFrame.tsx";
import { useCompact } from "./compact.ts";
import { connectionStatusOf, useConnectionStatus } from "./connectionStatus.ts";
import { runBusy, type CompactWorkspace } from "./ThreadSheet.tsx";
import { Rail } from "./Rail.tsx";
import { soloThread } from "./threadWindow.ts";

import { useWorkspaceSession } from "./useWorkspaceSession.ts";
import { useWorkspacePlaces } from "./useWorkspacePlaces.ts";
import { useWorkspacePanels } from "./useWorkspacePanels.ts";
import { useWorkspaceErrors } from "./workspaceErrors.ts";
import { useWorkspaceComposer } from "./useWorkspaceComposer.ts";
import { useWorkspaceThreads } from "./useWorkspaceThreads.ts";
import { useWorkspaceTabs } from "./useWorkspaceTabs.ts";
import { useWorkspacePresence } from "./useWorkspacePresence.ts";
import { useWorkspacePreview } from "./useWorkspacePreview.tsx";
import { useWorkspaceTools } from "./useWorkspaceTools.tsx";
import { useWorkspaceThreadLifecycle } from "./useWorkspaceThreadLifecycle.tsx";
import { useThreadPaneActions } from "./useThreadPaneActions.tsx";
import { useWorkspaceCommands } from "./useWorkspaceCommands.ts";
import { useWorkspaceShortcuts } from "./useWorkspaceShortcuts.ts";
import { workspacePage } from "./workspacePage.tsx";
import { WorkspaceNotices } from "./WorkspaceNotices.tsx";
import { workspacePaneViews, baseName } from "./workspacePaneViews.tsx";

const SIDEBAR_KEY = "cerium:sidebar";

export function Workspace() {
  const driven = useAtomValue(machineAtom);
  const solo = soloThread;
  const compact = useCompact();
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => stored(SIDEBAR_KEY) !== "hidden");
  const places = useWorkspacePlaces(solo);
  const {
    settingsOpen,
    setSettingsOpen,
    showThreads,
    openSettings,
    place,
    settingsCategory,
    setSettingsCategory,
    settingsPane,
    setSettingsPane,
  } = places;
  const panels = useWorkspacePanels();
  const {
    inspectorOpen,
    filesOpen,
    artifactsOpen,
    gitOpen,
    githubOpen,
    togglePanel,
    closePanel,
    setSidePanel,
    inspectedAgent,
    setInspectedAgent,
    toggleGit,
  } = panels;
  const errors = useWorkspaceErrors();
  const { setActionError } = errors;
  const sessionState = useWorkspaceSession({ driven, solo, compact, searchOpen });
  const {
    mode,
    setMode,
    openThread,
    panes,
    pane,
    setPane,
    openDraft,
    newProject,
    current,
    openFile,
    chooseFolder,
  } = sessionState;
  const composer = useWorkspaceComposer(current, setActionError);
  const { focusComposer, messageBox } = composer;
  const threads = useWorkspaceThreads({ driven, solo, active: openThread, filesOpen });
  const {
    selected,
    viewed,
    cloudSelected,
    summaries,
    account,
    thisComputer,
    drivenDevice,
    deviceOf,
    nameOf,
    openInWindow,
    markRead,
    markUnread,
    indicators,
    agents,
    lineage,
    connection,
    refreshThreads,
    drivenId,
    selectedSummary,
  } = threads;
  const tabView = useWorkspaceTabs({
    driven,
    solo,
    compact,
    sessionState,
    threads,
    showThreads,
    composer,
    closeSide: () => setSidePanel(undefined),
    clearInspectedAgent: () => setInspectedAgent(undefined),
    closeSearch: () => setSearchOpen(false),
  });
  const {
    tabs,
    openSummary,
    newThread,
    openNewDraft,
    discardDraft,
    panesArea,
    splitWith,
    openPaletteThread,
    openPaletteFile,
    splitNew,
    closePaneOf,
    focusOn,
    canDrop,
    dropOn,
    resize,
    openThreadById,
    beside,
    jumpNextWaiting,
    startThreadFrom,
  } = tabView;
  useWorkspacePresence({ driven, solo, compact, settingsOpen, pane, threads, openSummary });
  const bindings = useAtomValue(shortcutBindingsAtom);
  const keys = (id: ShortcutId): string => bindingFor(bindings, id);
  const save = useAtomSet(saveProject, { mode: "promise" });

  const projectTools = useWorkspaceTools({
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
  });
  const {
    filesRoot,
    fileRoots,
    gitRoot,
    terminal,
    runThreadId,
    runRunning,
    toggleRun,
    scriptsProject,
    projectActions,
    refreshProjectScripts,
    toggleAction,
    filesPanel,
    sourceControl,
    githubRoot,
    githubOk,
    automationsOk,
    githubPanel,
    viewedArtifacts,
    artifactsProject,
    artifactsAvailable,
    threadOf,
    showArtifact,
  } = projectTools;
  const returnToComposer = () =>
    tabView.returnToComposer(() => {
      if (terminal.open) terminal.hide();
    });

  // `cerium .` opens a new thread in that folder, and `cerium "fix login"` one with that prompt waiting in
  // its message box (apps/desktop/src/launch.ts). They are this computer's folders, so a window driving
  // another machine leaves them.
  useLaunchRequests((request) => {
    if (request.kind !== "folder" && request.kind !== "prompt") return false;
    if (driven === undefined) {
      tabView.startThreadFrom({
        folder: request.folder,
        text: request.kind === "prompt" ? request.text : "",
      });
    }
    return true;
  });

  // The Mac's menu bar and Dock menu: Settings… opens settings; New Thread leaves them for a new thread.
  useLaunchRequests((request) => {
    if (request.kind !== "menu") return false;
    if (request.command === "open-settings") openSettings();
    else {
      setSettingsOpen(false);
      newThread();
    }
    return true;
  });
  // What another app shared to the installed web client opens as a new thread with it in the message
  // box, once the window drives a computer and has come back to where it was: either would reset it.
  const shareReady = WEB && solo === undefined && driven !== undefined && !sessionState.resumePending;
  const takeShare = useEffectEvent(() => {
    const text = takeShared();
    if (text !== undefined) startThreadFrom({ folder: undefined, text });
  });
  useEffect(() => {
    if (shareReady) takeShare();
  }, [shareReady]);
  // Back from settings or the welcome, the cursor returns to the message box; a phone's keyboard stays down.
  const welcoming = useAtomValue(welcomeShownAtom);
  const focusAfterOverlay = useEffectEvent(focusComposer);
  useEffect(() => {
    if (!settingsOpen && !compact && !welcoming) focusAfterOverlay();
  }, [settingsOpen, compact, welcoming]);

  const toggleSidebar = () => {
    remember(SIDEBAR_KEY, sidebarOpen ? "hidden" : "shown");
    setSidebarOpen(!sidebarOpen);
  };

  const preview = useWorkspacePreview({ driven, solo, selected });
  const { previewDocks, previewThread, previewOpen, togglePreview, previews } = preview;

  /** An agent opened a page: its thread's preview shows, there or whenever the thread next does. */
  useLaunchRequests((request) => {
    if (request.kind !== "preview") return false;
    previewDocks.show(request.id);
    return true;
  });

  const lifecycle = useWorkspaceThreadLifecycle({
    sessionState,
    threads,
    tabView,
    focusComposer,
    showThreads,
    previewDocks,
    errors,
  });
  const { sidebarActions, archiveDialog } = lifecycle;

  const paneControls = useThreadPaneActions({
    driven,
    compact,
    sessionState,
    threads,
    tabView,
    composer,
    panels,
    tools: projectTools,
    errors,
    settingsOpen,
    searchOpen,
    welcoming,
    openSettings,
  });
  const {
    paneActions,
    workspacesOk,
    askStopAll,
    canStopAll,
    stopAllDialog,
    answerApproval,
    answerSpawn,
    answerQuestionOf,
    interruptFromInspector,
    stopFromInspector,
  } = paneControls;
  const [moveChatId, setMoveChatId] = useState<string>();
  const { paletteCommands, slashCommands } = useWorkspaceCommands({
    solo,
    compact,
    keys,
    sessionState,
    threads,
    tabView,
    composer,
    panels,
    tools: projectTools,
    places,
    lifecycle,
    preview,
    paneControls,
    errors,
    sidebarOpen,
    toggleSidebar,
    returnToComposer,
    ...(paneActions.moveToWork ? { onMoveToWork: (threadId: string) => setMoveChatId(threadId) } : {}),
  });

  useWorkspaceShortcuts({
    solo,
    compact,
    keys,
    searchOpen,
    setSearchOpen,
    places,
    sessionState,
    tabView,
    composer,
    panels,
    tools: projectTools,
    preview,
    paneControls,
    selected,
    toggleSidebar,
    returnToComposer,
  });

  const workspaceThread =
    workspacesOk && runThreadId !== undefined && !compact ? selected?.thread : undefined;

  // How the line to the open thread's computer stands: the compact frame times it itself, and the
  // machine picker marks its trigger with the timed one.
  const cloudHome =
    cloudSelected === undefined || cloudSelected.machine === drivenId ? undefined : cloudSelected.machine;
  const cloudDevice = cloudHome === undefined ? undefined : deviceOf(cloudHome);
  const connectionStatus = connectionStatusOf({
    connection,
    driven,
    presence: drivenDevice && !drivenDevice.online ? presenceLabel(drivenDevice) : undefined,
    cloud:
      cloudHome === undefined
        ? undefined
        : {
            machine: nameOf(cloudHome),
            reach: cloudDevice === undefined ? { kind: "offline" } : reachOf(cloudDevice),
          },
    web: WEB,
  });
  const timedConnectionStatus = useConnectionStatus(connectionStatus);
  const retryConnection = () => {
    reconnectNow();
    refreshThreads();
  };
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [triageOpen, setTriageOpen] = useState(false);
  const hasOtherMachines =
    account._tag === "SignedIn" &&
    account.devices.some((device) => device.kind === "desktop" && device.id !== drivenId);

  // Threads waiting on the user's approval, for the capsules and the triage sheet.
  const viewedId = viewed?.thread.id;
  const waiting = summaries.filter((summary) => summary.status === "awaitingApproval");
  const otherWaitingCount = waiting.filter((summary) => summary.id !== viewedId).length;
  const nextWaiting = viewedId === undefined ? undefined : nextWaitingThread(summaries, viewedId);

  const runProps =
    runThreadId === undefined
      ? undefined
      : {
          running: runRunning,
          onToggle: toggleRun,
          actions: projectActions,
          onAction: toggleAction,
          onMenuOpen: refreshProjectScripts,
          onEditActions: () => openSettings("sourceControl"),
        };
  // The compact thread bar's context line and the Thread sheet's Workspace row: the open work
  // thread's workspace, kept fresh by the subtitle since no titlebar shows it.
  const compactThread = compact && workspacesOk && runThreadId !== undefined ? selected?.thread : undefined;
  const compactWorkspace: CompactWorkspace | undefined =
    compactThread === undefined
      ? undefined
      : {
          threadId: compactThread.id as ThreadId,
          checkoutFolder: compactThread.worktree?.root ?? compactThread.cwd ?? "",
          projectRoot: compactThread.worktree?.project ?? compactThread.cwd ?? "",
          worktree: compactThread.worktree !== undefined,
          lineage,
          onOpenSourceControl: () => {
            if (!gitOpen) toggleGit();
          },
          onOpenThread: openThreadById,
        };

  const notices = <WorkspaceNotices driven={driven} solo={solo} threads={threads} errors={errors} />;
  const page = workspacePage({ compact, places, threads, tabView, tools: projectTools });
  const { paneContent, paneLabel } = workspacePaneViews({
    driven,
    solo,
    sessionState,
    threads,
    tabView,
    composer,
    panels,
    places,
    tools: projectTools,
    preview,
    paneActions,
    slashCommands,
    notices,
    ...(solo === undefined && viewed !== undefined
      ? {
          aboveComposer: (
            <WaitingPill
              current={selectedSummary}
              next={nextWaiting}
              draftKey={viewed.thread.id}
              onOpen={openThreadById}
            />
          ),
        }
      : {}),
    ...(compact ? { onOpenConnection: () => setThreadSheetOpen(true) } : {}),
  });
  const frame = (
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
      {...(page === undefined ? {} : { page })}
      connectionStatus={connectionStatus}
      onRetryConnection={retryConnection}
      threadSheetOpen={threadSheetOpen}
      onThreadSheetOpenChange={setThreadSheetOpen}
      hasOtherMachines={hasOtherMachines}
      onSwitchMachine={() => setSwitchOpen(true)}
      {...(solo === undefined
        ? {
            waitingCount: waiting.length,
            otherWaitingCount,
            onJumpWaiting: () => void jumpNextWaiting(),
            onOpenTriage: () => setTriageOpen(true),
          }
        : {})}
      extraBackDepth={(triageOpen ? 1 : 0) + (switchOpen ? 1 : 0)}
      onCloseOverlay={() => {
        if (switchOpen) setSwitchOpen(false);
        else setTriageOpen(false);
      }}
      {...(compactThread === undefined
        ? {}
        : {
            compactSubtitle: (
              <CompactWorkspaceSubtitle
                threadId={compactThread.id as ThreadId}
                project={compactThread.cwd ? baseName(compactThread.cwd) : undefined}
                checkoutFolder={compactThread.worktree?.root ?? compactThread.cwd}
                running={runBusy(runProps)}
              />
            ),
            compactSubtitleKey: compactThread.id,
          })}
      {...(compactWorkspace === undefined ? {} : { compactWorkspace })}
      rail={(orientation) => (
        <Rail
          view={settingsOpen ? "settings" : (place ?? (mode === "work" ? "home" : "chat"))}
          onSelect={(view) => {
            if (view === "settings") {
              if (settingsOpen) setSettingsOpen(false);
              else openSettings();
            } else if (view === "github" || view === "tasks" || view === "automations") {
              places.openPlace(view);
            } else {
              showThreads();
              setMode(view === "home" ? "work" : "chat");
            }
          }}
          harnesses={indicators}
          threads={summaries}
          onOpenLimits={() => openSettings("limits")}
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
          onNewThread={() => newThread(mode)}
          onMarkRead={markRead}
          onMarkUnread={markUnread}
          onNewThreadIn={(picked) => {
            chooseFolder(picked);
            void save({ payload: { path: picked } }).catch(() => undefined);
            newThread("work");
          }}
          {...sidebarActions}
          {...(paneActions.moveToWork ? { onMoveToWork: (threadId: string) => setMoveChatId(threadId) } : {})}
          {...(openInWindow ? { onOpenWindow: openInWindow } : {})}
          open={tabs.tabs.map((tab) => tab.key)}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          onRefresh={retryConnection}
        />
      }
      machinePicker={<MachinePicker account={account} status={timedConnectionStatus} />}
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
          <SettingsView
            category={settingsCategory}
            active={settingsOpen && (!compact || settingsPane === "page")}
            harnesses={indicators}
            onOpen={setSettingsCategory}
            project={scriptsProject ?? newProject}
          />
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
                  onInterrupt={interruptFromInspector}
                  onStop={stopFromInspector}
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
      workspace={
        workspaceThread !== undefined ? (
          <WorkspaceStatus
            key={workspaceThread.id}
            threadId={workspaceThread.id as ThreadId}
            checkoutFolder={workspaceThread.worktree?.root ?? workspaceThread.cwd ?? ""}
            projectRoot={workspaceThread.worktree?.project ?? workspaceThread.cwd ?? ""}
            onOpenSourceControl={() => {
              if (!gitOpen) toggleGit();
            }}
            onOpenThread={openThreadById}
            lineage={lineage}
          />
        ) : lineage !== undefined ? (
          <ThreadLineage key={viewed?.thread.id} lineage={lineage} onOpenThread={openThreadById} />
        ) : undefined
      }
      {...(runProps === undefined ? {} : { run: runProps })}
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
            onResize={resize}
            onClose={closePaneOf}
            onSplit={splitNew}
            canDrop={canDrop}
            onDrop={dropOn}
          />
        </div>
      )}
      {/* The main window keeps the account's drafts and tasks in sync. */}
      {solo ? null : (
        <>
          <DraftSync signedIn={account._tag === "SignedIn"} here={WEB ? undefined : thisComputer} />
          <TaskSync signedIn={account._tag === "SignedIn"} />
        </>
      )}
      {solo ? null : (
        <>
          <TriageSheet
            open={triageOpen}
            onOpenChange={setTriageOpen}
            threads={summaries}
            current={viewedId}
            onOpen={openThreadById}
          />
          <SwitchComputerSheet open={switchOpen} onOpenChange={setSwitchOpen} account={account} />
        </>
      )}
      {stopAllDialog}
      {archiveDialog}
      {moveChatId && paneActions.moveToWork ? (
        <MoveToWorkDialog
          open={moveChatId !== undefined}
          onOpenChange={(open) => {
            if (!open) setMoveChatId(undefined);
          }}
          actions={{
            projects: sessionState.projects,
            defaultFolder: sessionState.defaultFolder,
            available: threads.available,
            worktrees: tabView.worktreesOk,
            onMove: (choice) => paneActions.moveToWork!(moveChatId as ThreadId, choice),
          }}
        />
      ) : null}
    </AppFrame>
  );
  return (
    <>
      {frame}
      {solo ? null : (
        <CommandPalette
          open={searchOpen}
          onOpenChange={setSearchOpen}
          mode={mode}
          threads={summaries}
          messageSearch={
            drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= THREAD_SEARCH_VERSION
          }
          onOpenThread={openPaletteThread}
          fileRoots={fileRoots}
          onOpenFile={openPaletteFile}
          modifierShortcuts={!compact}
          commands={paletteCommands}
        />
      )}
    </>
  );
}

/** The pill to the next thread waiting, over the open thread's box: it fades once the user writes there. */
function WaitingPill({
  current,
  next,
  draftKey,
  onOpen,
}: {
  current: ThreadSummary | undefined;
  next: ThreadSummary | undefined;
  draftKey: string;
  onOpen: (threadId: string) => void;
}) {
  const typing = hasContent(useAtomValue(draftsAtom)[draftKey]);
  return <NextWaitingPill current={current} next={next} onOpen={onOpen} dismissed={typing} />;
}
