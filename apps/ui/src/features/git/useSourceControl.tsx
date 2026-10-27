import type { ThreadId } from "@cerium/protocol";
import type { GitFileChange } from "@cerium/rpc";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { X } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { refreshBranches } from "../../backend/branches.ts";
import { watchAtom } from "../../backend/explorer.ts";
import {
  discardFiles,
  gitStatusAtom,
  refreshGitStatus,
  stageFiles,
  unstageFiles,
} from "../../backend/git.ts";
import { initRepository } from "../../backend/repositories.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { MessageBoxContext, type MessageBox } from "../composer/messageBox.ts";
import type { OpenFile } from "../files/model.ts";
import { useReviewsOffered } from "../review/hooks.ts";
import { fileKey } from "../viewer/model.ts";
import { useBranchPanel } from "./branches/useBranchPanel.tsx";
import { ChangesView, type ChangeActions } from "./ChangesView.tsx";
import { CommitBox } from "./CommitBox.tsx";
import { HistoryPanel } from "./history/HistoryPanel.tsx";
import { diffSideAtom, discardWords, unstagePaths, type DiscardWords } from "./model.ts";
import { SourceControlPanel } from "./SourceControlPanel.tsx";

const reasonOf = (error: unknown, fallback: string) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Git couldn't say what changed.";
};

/** Opens a file of the folder `root` as one commit changed it, in the viewer, from the History tab. */
type OpenCommitFile = (
  root: string,
) => (sha: string, file: { readonly path: string; readonly from?: string }) => void;

/**
 * Source control for the repository a thread's folder `root` is in, while it is open, kept current:
 * the machine says what changes in the repository, git's own folder included, so what's on screen
 * follows the agents' edits, staging and commits as well as the user's.
 */
export function useSourceControl({
  root,
  open,
  openIn,
  openCommitFile,
  activeFile,
  review,
  onClose,
}: {
  /** The thread's folder; none where there is no repository to show. */
  root: string | undefined;
  /**
   * The thread whose agents made the changes, which Commit's review reports to, and its message box,
   * which takes the findings sent to them; none for a thread not started yet.
   */
  review?: { readonly threadId: ThreadId; readonly messageBox: MessageBox | undefined } | undefined;
  /** The panel is shown. */
  open: boolean;
  /** Opens a file of the folder `top` in the viewer; absent where the machine can't serve one. */
  openIn: ((top: string) => OpenFile) | undefined;
  /** Opens the files of commits in the viewer, the History tab's, for the folder it's given. */
  openCommitFile: OpenCommitFile;
  /** The file the viewer shows, by the folder it's in. */
  activeFile: { readonly root: string; readonly path: string } | undefined;
  onClose: () => void;
}): ReactNode | undefined {
  const active = root !== undefined && open;
  return active ? (
    <SourceControl
      root={root}
      openIn={openIn}
      openCommitFile={openCommitFile}
      activeFile={activeFile}
      review={review}
      onClose={onClose}
    />
  ) : undefined;
}

function SourceControl({
  root,
  openIn,
  openCommitFile,
  activeFile,
  review,
  onClose,
}: {
  root: string;
  openIn: ((top: string) => OpenFile) | undefined;
  openCommitFile: OpenCommitFile;
  activeFile: { readonly root: string; readonly path: string } | undefined;
  review: { readonly threadId: ThreadId; readonly messageBox: MessageBox | undefined } | undefined;
  onClose: () => void;
}) {
  const reviewsOffered = useReviewsOffered();
  const registry = useContext(RegistryContext);
  const result = useAtomValue(gitStatusAtom(root));
  const status = Option.getOrUndefined(AsyncResult.value(result));
  const error = AsyncResult.isFailure(result) ? messageOf(result.cause) : undefined;
  const top = status?.top;

  // The machine says what changed in the repository, in batches: the whole of it, from its top.
  const onBatch = useEffectEvent((changed: boolean) => {
    if (changed) {
      refreshGitStatus(registry, root);
      refreshBranches(registry, root);
    }
  });
  useEffect(() => {
    if (top === undefined) return;
    // An atom isn't read until asked to, so `immediate` is what starts the watching.
    return registry.subscribe(
      watchAtom(top),
      (batch) => {
        if (AsyncResult.isSuccess(batch)) onBatch(batch.value.status || batch.value.overflow === true);
      },
      { immediate: true },
    );
  }, [registry, top]);

  const open = top === undefined ? undefined : openIn?.(top);
  const count =
    status === undefined ? 0 : status.staged.length + status.unstaged.length + status.conflicted.length;
  const branches = useBranchPanel({ root, onOpen: open === undefined ? undefined : (path) => open(path) });

  const stage = useAtomSet(stageFiles, { mode: "promise" });
  const unstage = useAtomSet(unstageFiles, { mode: "promise" });
  const discard = useAtomSet(discardFiles, { mode: "promise" });
  const init = useAtomSet(initRepository, { mode: "promise" });
  /** What the last change from the lists couldn't do, in words for the user. */
  const [failure, setFailure] = useState<string>();
  /** The discard waiting on the user's go-ahead, with the words it asks with. */
  const [asking, setAsking] = useState<{
    readonly paths: ReadonlyArray<string>;
    readonly words: DiscardWords;
    readonly open: boolean;
  }>();

  const change = async (work: () => Promise<unknown>, fallback: string) => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(reasonOf(error, fallback));
    }
    // Not a `finally`: the React Compiler skips a component that has one. The catch takes every
    // failure, so this runs either way.
    refreshGitStatus(registry, root);
  };
  /** Makes the thread's folder a repository, then reads it and its branches as the new repository. */
  const initialize = () =>
    void change(async () => {
      await init({ payload: { root } });
      refreshBranches(registry, root);
    }, "Git couldn't make this folder a repository.");
  const paths = (changes: ReadonlyArray<GitFileChange>) => changes.map((each) => each.path);
  const actions: ChangeActions | undefined =
    top === undefined
      ? undefined
      : {
          stage: (changes) =>
            void change(
              () => stage({ payload: { root: top, paths: paths(changes) } }),
              "Git couldn't stage that.",
            ),
          unstage: (changes) =>
            void change(
              () => unstage({ payload: { root: top, paths: unstagePaths(changes) } }),
              "Git couldn't unstage that.",
            ),
          discard: (changes, where) =>
            setAsking({
              paths: where === undefined ? paths(changes) : [where],
              words: discardWords(changes, where),
              open: true,
            }),
        };

  const activePath = activeFile !== undefined && activeFile.root === top ? activeFile.path : undefined;
  /** The side of it the viewer shows, so only that list marks it. */
  const activeSide = useAtomValue(diffSideAtom(fileKey(top ?? "", activePath ?? "")));

  /** Opens a file from the lists: on what's staged, on what isn't, or a conflicted one as it is, markers and all. */
  const openChange = (change: GitFileChange, group: "conflicted" | "staged" | "unstaged") => {
    if (open === undefined || top === undefined) return;
    registry.set(diffSideAtom(fileKey(top, change.path)), group === "conflicted" ? undefined : group);
    if (group === "conflicted") open(change.path);
    else open(change.path, { changes: true });
  };

  return (
    <>
      <SourceControlPanel
        header={branches.header}
        notice={branches.notice}
        changes={
          <>
            {branches.banner}
            <ChangesView
              status={status}
              error={error}
              activePath={activePath}
              activeGroup={activeSide}
              onOpen={open === undefined ? undefined : openChange}
              actions={actions}
              onInit={initialize}
            >
              {top === undefined || status === undefined ? null : (
                <MessageBoxContext value={review?.messageBox}>
                  <CommitBox
                    top={top}
                    staged={status.staged.length}
                    changed={status.unstaged.length}
                    conflicted={status.conflicted.length}
                    threadId={reviewsOffered ? review?.threadId : undefined}
                    onCommitted={() => {
                      refreshGitStatus(registry, root);
                      refreshBranches(registry, root);
                    }}
                  />
                </MessageBoxContext>
              )}
              {failure === undefined ? null : (
                <div
                  role="alert"
                  className="mx-3 mt-2 flex items-start gap-1 rounded-lg bg-error/10 py-1 pr-1 pl-2.5"
                >
                  <p className="min-w-0 flex-1 py-0.5 text-meta text-error-text max-md:text-[14px]">
                    {failure}
                  </p>
                  <IconButton
                    icon={X}
                    label="Dismiss"
                    onClick={() => setFailure(undefined)}
                    className="size-6"
                  />
                </div>
              )}
            </ChangesView>
          </>
        }
        changeCount={count}
        history={<HistoryPanel key={root} root={root} onOpenFile={openCommitFile(root)} />}
        onRefresh={() => {
          refreshGitStatus(registry, root);
          refreshBranches(registry, root);
        }}
        onClose={onClose}
      />
      {branches.dialogs}
      <ConfirmDialog
        open={asking?.open === true}
        onOpenChange={(next) => {
          // The words stay while the dialog fades out.
          if (!next && asking !== undefined) setAsking({ ...asking, open: false });
        }}
        title={asking?.words.title ?? ""}
        description={asking?.words.description ?? ""}
        confirmLabel={asking?.words.confirm ?? "Discard"}
        onConfirm={() => {
          if (asking?.open !== true || top === undefined) return;
          const { paths: chosen } = asking;
          void change(
            () => discard({ payload: { root: top, paths: chosen } }),
            "Git couldn't discard those changes.",
          );
        }}
      />
    </>
  );
}
