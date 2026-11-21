import { type ThreadId, type WorktreeChanges } from "@cerium/protocol";
import { type TeardownReport } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import {
  continueThread,
  deleteThread,
  renameThread,
  setThreadArchived,
  setThreadLater,
} from "../backend/atoms.ts";
import { worktreeChanges } from "../backend/projects.ts";
import { draftsAtom, revokeLostPreviews, withDraft, withoutDraft } from "../features/composer/drafts.ts";
import { tasksAtom, unlinkDeletedThread } from "../features/tasks/tasks.ts";
import { ArchiveWorktreeDialog } from "../features/threads/ArchiveWorktree.tsx";
import { archiveRunSiblings, planKeepRun } from "../features/threads/runs.ts";
import { CONTINUE_VERSION, LATER_VERSION, type ThreadSummary } from "../features/threads/model.ts";
import { closeKeys, renameKey, singlePane } from "../features/split/model.ts";

import type { PreviewDocks } from "../features/preview/usePreviewDocks.ts";
import { MAIN_PANE, type WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import { messageOf, type useWorkspaceErrors } from "./workspaceErrors.ts";

export function useWorkspaceThreadLifecycle({
  sessionState,
  threads,
  tabView,
  focusComposer,
  showThreads,
  previewDocks,
  errors,
}: {
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly focusComposer: () => void;
  readonly showThreads: () => void;
  readonly previewDocks: PreviewDocks;
  readonly errors: ReturnType<typeof useWorkspaceErrors>;
}) {
  const registry = useContext(RegistryContext);
  const { mode, setPanesByMode, setOpenThread, setPane } = sessionState;
  const { summaries, drivenId, drivenDevice, refreshThreads, beginPutAway, settlePutAway, undoPutAway } =
    threads;
  const { tabs, openSummary } = tabView;
  const { attempt, setActionError } = errors;
  const comparisonView = useRef({ drivenId, mode, dropMany: tabs.dropMany });
  useLayoutEffect(() => {
    comparisonView.current = { drivenId, mode, dropMany: tabs.dropMany };
  });
  const rename = useAtomSet(renameThread, { mode: "promise" });
  const setArchived = useAtomSet(setThreadArchived, { mode: "promise" });
  const continueIn = useAtomSet(continueThread, { mode: "promise" });
  const putOff = useAtomSet(setThreadLater, { mode: "promise" });
  const remove = useAtomSet(deleteThread, { mode: "promise" });
  const changesOf = useAtomSet(worktreeChanges, { mode: "promise" });
  /** A thread whose worktree holds unmerged work, waiting on the user to confirm archiving it. */
  const [archiving, setArchiving] = useState<{ thread: ThreadSummary; changes: WorktreeChanges }>();
  const reportTeardown = (title: string, teardown: TeardownReport | undefined) => {
    if (teardown === undefined) return;
    setActionError(
      `The teardown of “${title}” (${teardown.script}) ${teardown.failure}. The thread was put away anyway.`,
    );
  };

  /** Shows a thread archived or deleted at once, and closes its tab, while the machine puts it away. */
  const putAway = (threadId: string, deleting: boolean) => {
    beginPutAway(threadId, deleting);
    tabs.drop(threadId);
  };

  /**
   * Archives a thread and closes its tab; resolves whether it went.
   * `discardWork` once the user confirmed losing its worktree's work.
   */
  const archive = (threadId: string, { discardWork = false, closeTab = true } = {}): Promise<boolean> => {
    if (closeTab) putAway(threadId, false);
    return attempt(
      setArchived({
        payload: { threadId: threadId as ThreadId, archived: true, ...(discardWork ? { discardWork } : {}) },
      }).then(({ title, teardown }) => reportTeardown(title, teardown)),
    ).then((archived) => {
      if (closeTab) settlePutAway(threadId, archived);
      if (!archived) return false;
      if (!closeTab) beginPutAway(threadId, false, true);
      previewDocks.retire(threadId);
      refreshThreads();
      return true;
    });
  };

  /** Checks the worktree for both archive actions. A comparison leaves changed worktrees in place. */
  const archiveFromSidebar = async (threadId: string, comparison = false): Promise<string | undefined> => {
    const thread = summaries.find((summary) => summary.id === threadId);
    if (thread?.worktree !== undefined) {
      try {
        const changes = await changesOf({ payload: { threadId: threadId as ThreadId } });
        if (changes.uncommitted + changes.unmerged > 0) {
          if (!comparison) setArchiving({ thread, changes });
          return "its worktree has uncommitted or unmerged changes";
        }
      } catch (error: unknown) {
        setActionError(messageOf(error));
        return "its worktree could not be checked";
      }
    }
    if (comparison && comparisonView.current.drivenId !== drivenId) return "the selected machine changed";
    return (await archive(threadId, { closeTab: !comparison })) ? undefined : "the archive failed";
  };

  const keepComparison = async (winnerId: string) => {
    const winner = summaries.find((thread) => thread.id === winnerId);
    if (
      !winner ||
      winner.runId === undefined ||
      winner.elsewhere !== undefined ||
      winner.archivedAt !== undefined
    ) {
      return { act: [], skipped: [] };
    }
    tabs.openAs(winnerId, "tab");
    tabs.keep(winnerId);
    openSummary(winner);
    const siblings = summaries.filter((thread) => thread.runId === winner.runId);
    const result = await archiveRunSiblings(planKeepRun(siblings, winnerId), (id) =>
      comparisonView.current.drivenId === drivenId
        ? archiveFromSidebar(id, true)
        : Promise.resolve("the selected machine changed"),
    );
    const archived = result.act.map((thread) => thread.id);
    if (archived.length === 0) return result;
    const view = comparisonView.current;
    if (view.drivenId === drivenId && view.mode === winner.mode) {
      view.dropMany(archived, winnerId);
    } else {
      tabs.dropMany(archived, winnerId, true);
      if (view.drivenId === drivenId) {
        setPanesByMode((all) => {
          const previous = all[winner.mode];
          if (previous === undefined) return all;
          const left = closeKeys(previous, archived);
          if (left === undefined) return { ...all, [winner.mode]: singlePane(MAIN_PANE, winnerId) };
          return { ...all, [winner.mode]: left };
        });
        setOpenThread((all) =>
          archived.includes(all[winner.mode] ?? "") ? { ...all, [winner.mode]: winnerId } : all,
        );
      }
    }
    return result;
  };

  /**
   * Continues a thread in a new one on the same model, folder and worktree, which takes its tab and
   * pane with the brief Cerium wrote in its message box, for the user to edit and send. The old thread
   * is archived.
   */
  const continueFresh = (threadId: string): Promise<boolean> =>
    attempt(
      continueIn({ payload: { threadId: threadId as ThreadId } }).then(({ thread, brief }) => {
        previewDocks.retire(threadId);
        registry.set(
          draftsAtom,
          withDraft(registry.get(draftsAtom), thread.id, () => ({
            segments: [{ kind: "text", text: brief }],
            attachments: [],
          })),
        );
        tabs.started(threadId, thread.id);
        setPanesByMode((all) => {
          const stored = all[thread.mode];
          return stored === undefined
            ? all
            : { ...all, [thread.mode]: renameKey(stored, threadId, thread.id) };
        });
        showThreads();
        setOpenThread((open) => ({ ...open, [thread.mode]: thread.id }));
        setPane("main");
        refreshThreads();
        requestAnimationFrame(focusComposer);
      }),
    );
  const canContinue = drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= CONTINUE_VERSION;

  const renameFromSidebar = (threadId: string, title: string) =>
    attempt(rename({ payload: { threadId: threadId as ThreadId, title } })).then((renamed) => {
      if (renamed) refreshThreads();
      return renamed;
    });

  const restoreArchived = (threadId: string, optimistic = false): Promise<boolean> => {
    const undo = optimistic ? undoPutAway(threadId) : undefined;
    return attempt(setArchived({ payload: { threadId: threadId as ThreadId, archived: false } })).then(
      (restored) => {
        if (restored) {
          // Undo can restore the thread before the list ever sees it archived.
          undo?.();
          refreshThreads();
        }
        return restored;
      },
    );
  };

  // Deleting a thread closes its tab. Its dialog said a worktree goes with it.
  const deleteFromSidebar = (threadId: string): Promise<boolean> => {
    const title = summaries.find((summary) => summary.id === threadId)?.title ?? "the thread";
    putAway(threadId, true);
    return attempt(
      remove({ payload: { threadId: threadId as ThreadId, discardWork: true } }).then((teardown) =>
        reportTeardown(title, teardown),
      ),
    ).then((deleted) => {
      settlePutAway(threadId, deleted);
      if (!deleted) return false;
      const held = registry.get(draftsAtom);
      const rest = withoutDraft(held, threadId);
      revokeLostPreviews(held, rest);
      registry.set(draftsAtom, rest);
      const taskStore = registry.get(tasksAtom);
      const unlinked = unlinkDeletedThread(taskStore, threadId, Date.now());
      if (unlinked !== taskStore) registry.set(tasksAtom, unlinked);
      previewDocks.close(threadId);
      refreshThreads();
      return true;
    });
  };

  const later = (threadId: string, until: number | undefined): Promise<boolean> =>
    attempt(
      putOff({ payload: { threadId: threadId as ThreadId, ...(until === undefined ? {} : { until }) } }),
    ).then((done) => {
      if (done) refreshThreads();
      return done;
    });

  const sidebarActions = {
    onRename: renameFromSidebar,
    // A thread whose worktree holds work its base doesn't asks first.
    // Each resolves whether the thread went, so the sidebar's bulk bar reports what worked.
    onArchive: (threadId: string) => archiveFromSidebar(threadId).then((reason) => reason === undefined),
    onKeepRun: keepComparison,
    onRestore: (threadId: string) => restoreArchived(threadId, true),
    onDelete: deleteFromSidebar,
    ...(drivenDevice === undefined || (drivenDevice.rpcVersion ?? 0) >= LATER_VERSION
      ? { onLater: later }
      : {}),
    ...(canContinue ? { onContinue: continueFresh } : {}),
  };

  const archiveDialog = archiving?.thread.worktree ? (
    <ArchiveWorktreeDialog
      thread={{ ...archiving.thread, worktree: archiving.thread.worktree }}
      changes={archiving.changes}
      open
      onOpenChange={(open) => {
        if (!open) setArchiving(undefined);
      }}
      onConfirm={() => void archive(archiving.thread.id, { discardWork: true })}
    />
  ) : null;

  return { sidebarActions, archiveDialog, canContinue, continueFresh, restoreArchived };
}

export type WorkspaceThreadLifecycle = ReturnType<typeof useWorkspaceThreadLifecycle>;
