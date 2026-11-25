import { type DeviceId, type DeviceInfo } from "@cerium/protocol";
import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useRef } from "react";

import { driveMachine } from "../backend/machine.ts";
import { hasContent } from "../features/composer/draft.ts";
import {
  draftsAtom,
  isNewDraftKey,
  newDraftKey,
  startedNow,
  withDraft,
  withoutDraft,
  type NewThreadDraft,
} from "../features/composer/drafts.ts";
import type { PaletteOpen } from "../features/palette/palette.ts";
import { useThreadTabs } from "../features/tabs/useThreadTabs.ts";
import { nextWaitingThread, type ThreadSummary } from "../features/threads/model.ts";
import { WORKTREE_VERSION } from "../features/threads/worktree.ts";
import type { DragSource } from "../features/split/drag.ts";
import {
  canSplit,
  closeKeys,
  closePane,
  findPane,
  focusedKey,
  focusPane,
  isSplit,
  layoutOf,
  leavesOf,
  movePane,
  paneShowing,
  resizeSplit,
  showInPane,
  singlePane,
  splitPane,
  type DropZone,
  type Panes,
  type Side,
} from "../features/split/model.ts";
import { MIN_PANE } from "../features/split/SplitView.tsx";
import { fileKey } from "../features/viewer/model.ts";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import type { AppMode } from "./mode.ts";
import { rememberSession } from "./session.ts";
import { besideThread } from "./threadWindow.ts";

import type { SplitPath } from "../features/split/model.ts";
import type { WorkspaceChoice } from "@cerium/protocol";
import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";
import { MAIN_PANE, newPaneId, type WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";

export interface ThreadBrief {
  /** None leaves the project to the message box's own choice. */
  readonly folder: string | undefined;
  readonly text: string;
  /** Runs in a worktree of its own; left to the message box's own choice when absent. */
  readonly worktree?: boolean;
  readonly workspace?: WorkspaceChoice;
  readonly taskId?: string;
}

export function useWorkspaceTabs({
  driven,
  solo,
  compact,
  sessionState,
  threads,
  showThreads,
  closeSide,
  composer,
  clearInspectedAgent,
  closeSearch,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly compact: boolean;
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly showThreads: () => void;
  readonly closeSide: () => void;
  readonly composer: WorkspaceComposer;
  readonly clearInspectedAgent: () => void;
  readonly closeSearch: () => void;
}) {
  const registry = useContext(RegistryContext);
  const {
    mode,
    current,
    blank,
    setBlank,
    openThread,
    setOpenThread,
    panes,
    storedPanes,
    setStoredPanes,
    split,
    pane,
    setPane,
    setOpenAfterSwitch,
    session,
    resumePending,
  } = sessionState;
  const { live, summaries, thisComputer, nameOf, reachableHome, setHeldUnread, drivenDevice, projectOf } =
    threads;
  const { focusComposer, routedDraftKey, scheduleFocus } = composer;
  /** Opens another machine's thread there: the window drives that machine, then shows it. */
  const openOn = (device: DeviceInfo, threadId: string, next?: Panes) => {
    setOpenAfterSwitch({ id: threadId, ...(next === undefined ? {} : { panes: next }) });
    setPane("main");
    driveMachine(registry, device.id === thisComputer ? undefined : { id: device.id, name: device.name });
  };
  const openSummary = (summary: ThreadSummary, next?: Panes) => {
    showThreads();
    setHeldUnread(summary.unread ? summary.id : undefined);
    const home = reachableHome(summary);
    if (home) {
      openOn(home, summary.id, next);
      return;
    }
    setOpenThread(summary.id);
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
      setOpenThread(key);
      setPane("main");
    },
    onFresh: (key, focus) => {
      showThreads();
      setBlank(key);
      setOpenThread(undefined);
      setPane("main");
      if (focus) focusComposer();
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
      setStoredPanes(left);
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
      ...(storedPanes === undefined ? {} : { panes: storedPanes }),
    });
  }, [resumePending, solo, driven, mode, openThread, blank, pane, tabs.strips, storedPanes]);

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
      setStoredPanes(next);
      setOpenThread(focusedKey(next));
      return;
    }
    tabs.openAs(key, "tab");
    tabs.keep(key);
    showThreads();
    setOpenThread(key);
    setPane("main");
    // The narrow window shows one pane: the tab takes the panel's place.
    if (compact) closeSide();
  };
  /**
   * Starts a work thread that looks into a pull request or an issue: a new thread in the folder's
   * project with the brief in its message box, for the user to pick the model and send.
   */
  const startThreadFrom = ({ folder, text, worktree, workspace, taskId }: ThreadBrief) => {
    const key = newDraftKey("work");
    registry.set(
      draftsAtom,
      withDraft(registry.get(draftsAtom), key, () => ({
        segments: text === "" ? [] : [{ kind: "text", text }],
        attachments: [],
        start: startedNow({
          mode: "work",
          ...(folder === undefined ? {} : { folder: projectOf(folder) }),
          ...(driven ? { machine: driven.id } : {}),
          ...(worktree === undefined || !worktreesOk ? {} : { worktree }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(taskId === undefined ? {} : { taskId }),
        }),
      })),
    );
    if (solo) {
      showTab(key);
      focusComposer();
      return;
    }
    showThreads();
    tabs.openAs(key, "tab");
    setOpenThread(key);
    setPane("main");
    if (compact) closeSide();
    focusComposer();
  };
  /**
   * Opens a blank new thread or chat, ready to type the first message: in a tab of its own, unless
   * a tab already holds an empty one of that mode. One the user wrote in stays in the sidebar as a draft.
   */
  const startNew = (targetMode: AppMode = mode) => {
    showThreads();
    tabs.newTab(targetMode);
    focusComposer();
  };

  /** Opens a thread not started yet, on the machine it starts on. */
  const openNewDraft = (draft: NewThreadDraft) => {
    showThreads();
    setPane("main");
    const home = draft.machine === thisComputer ? undefined : draft.machine;
    if (home !== driven?.id) {
      setOpenAfterSwitch({ id: draft.key });
      driveMachine(registry, home === undefined ? undefined : { id: home as DeviceId, name: nameOf(home) });
      return;
    }
    setOpenThread(draft.key);
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

  /** The user asked for a new thread or chat: in the narrow window, that's its pane. */
  const newThread = (targetMode: AppMode = mode) => {
    startNew(targetMode);
    setPane("main");
  };
  /**
   * Lays the panes out as `next` and shows the focused pane's thread. The thread the focused pane
   * showed before stays in a tab of its own, so no later preview takes its tab while it shows.
   */
  const applyPanes = (next: Panes) => {
    setStoredPanes(next);
    const shown = focusedKey(next);
    if (shown === current) return;
    tabs.keep(openThread ?? blank);
    tabs.openAs(shown, "tab");
    showThreads();
    setOpenThread(shown);
    setPane("main");
  };
  const returnToComposer = (hideTerminal: () => void) => {
    showThreads();
    closeSearch();
    setPane("main");
    clearInspectedAgent();
    if (compact) {
      closeSide();
      hideTerminal();
    }
    if (isNonThreadKey(current)) {
      const thread = summaries.find((summary) => summary.id === routedDraftKey);
      if (thread) {
        openSummary(thread);
      } else {
        const key = solo?.id ?? routedDraftKey ?? blank;
        setOpenThread(key);
      }
    }
    scheduleFocus();
  };
  /** The room the panes have, in pixels, which a split needs enough of. */
  const panesArea = useRef<HTMLDivElement>(null);
  const paneSize = (id: string, layout: Panes = panes) => {
    const box = layoutOf(layout.root).panes.find(({ leaf }) => leaf.id === id)?.box;
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
  const openPaletteThread = (id: string, as: PaletteOpen) => {
    const summary = summaries.find((thread) => thread.id === id);
    if (summary === undefined) return;
    const home = reachableHome(summary);
    if (as === "split" && !compact) {
      const target = home !== undefined ? singlePane(MAIN_PANE, newDraftKey(summary.mode)) : panes;
      if (focusedKey(target) !== id && canSplit(paneSize(target.focused, target), "right", MIN_PANE)) {
        const next = splitPane(target, target.focused, "right", id, newPaneId());
        setHeldUnread(summary.unread ? id : undefined);
        if (home === undefined) applyPanes(next);
        else {
          tabs.openAs(id, "tab");
          openSummary(summary, next);
        }
        return;
      }
    }
    if (as !== "default") {
      if (home === undefined && openThread === id) tabs.keep(id);
      else tabs.openAs(id, "tab");
    }
    openSummary(summary);
  };
  const openPaletteFile = (root: string, path: string, as: PaletteOpen) => {
    const key = fileKey(root, path);
    if (as === "split" && key !== current && splitWith(panes.focused, "right", key)) return;
    showTab(key);
  };
  /** A new thread on `side` of the pane `target`, ready to write in. */
  const splitNew = (target: string, side: Side) => {
    if (splitWith(target, side, newDraftKey(mode))) scheduleFocus();
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
    // A tab shown elsewhere carries its pane with it, or trades places on a center drop.
    if (showing !== undefined) applyPanes(movePane(panes, showing.id, target, zone));
    else if (zone !== "center") applyPanes(splitPane(panes, target, zone, source.key, newPaneId()));
    else applyPanes(showInPane(panes, target, source.key));
  };
  const jumpNextWaiting = () => {
    const next = nextWaitingThread(summaries, current);
    if (next === undefined) return false;
    openSummary(next);
    if (compact) closeSide();
    return true;
  };
  const openThreadById = (threadId: string) => {
    const summary = summaries.find((candidate) => candidate.id === threadId);
    if (summary) openSummary(summary);
  };
  /** The tabs showing in panes besides the focused one, which say so. */
  const beside = new Set(
    split
      ? leavesOf(panes.root)
          .filter((leaf) => leaf.id !== panes.focused)
          .map((leaf) => leaf.key)
      : [],
  );

  const resize = (path: SplitPath, sizes: ReadonlyArray<number>) =>
    applyPanes(resizeSplit(panes, path, sizes));

  return {
    tabs,
    openOn,
    openSummary,
    showTab,
    startThreadFrom,
    startNew,
    newThread,
    openNewDraft,
    discardDraft,
    returnToComposer,
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
    jumpNextWaiting,
    openThreadById,
    beside,
    worktreesOk,
  };
}
export type WorkspaceTabs = ReturnType<typeof useWorkspaceTabs>;
