import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, type ReactNode } from "react";

import { watchAtom } from "../../backend/explorer.ts";
import { gitStatusAtom, refreshGitStatus } from "../../backend/git.ts";
import type { OpenFile } from "../files/model.ts";
import { ChangesView } from "./ChangesView.tsx";
import { SourceControlPanel } from "./SourceControlPanel.tsx";

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Git couldn't say what changed.";
};

/**
 * Source control for the repository a thread's folder `root` is in, while it is open, kept current:
 * the machine says what changes in the repository, git's own folder included, so what's on screen
 * follows the agents' edits, staging and commits as well as the user's.
 */
export function useSourceControl({
  root,
  open,
  openIn,
  activeFile,
  onClose,
}: {
  /** The thread's folder; none where there is no repository to show. */
  root: string | undefined;
  /** The panel is shown. */
  open: boolean;
  /** Opens a file of the folder `top` in the viewer; absent where the machine can't serve one. */
  openIn: ((top: string) => OpenFile) | undefined;
  /** The file the viewer shows, by the folder it's in. */
  activeFile: { readonly root: string; readonly path: string } | undefined;
  onClose: () => void;
}): ReactNode | undefined {
  const active = root !== undefined && open;
  return active ? (
    <SourceControl root={root} openIn={openIn} activeFile={activeFile} onClose={onClose} />
  ) : undefined;
}

function SourceControl({
  root,
  openIn,
  activeFile,
  onClose,
}: {
  root: string;
  openIn: ((top: string) => OpenFile) | undefined;
  activeFile: { readonly root: string; readonly path: string } | undefined;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(gitStatusAtom(root));
  const status = Option.getOrUndefined(AsyncResult.value(result));
  const error = AsyncResult.isFailure(result) ? messageOf(result.cause) : undefined;
  const top = status?.top;

  // The machine says what changed in the repository, in batches: the whole of it, from its top.
  const onBatch = useEffectEvent((changed: boolean) => {
    if (changed) refreshGitStatus(registry, root);
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

  return (
    <SourceControlPanel
      // Branch and sync controls go here.
      header={undefined}
      changes={
        <ChangesView
          status={status}
          error={error}
          activePath={activeFile !== undefined && activeFile.root === top ? activeFile.path : undefined}
          onOpen={open === undefined ? undefined : (change) => open(change.path, { changes: true })}
        />
      }
      changeCount={count}
      // The History tab goes here.
      history={undefined}
      onRefresh={() => refreshGitStatus(registry, root)}
      onClose={onClose}
    />
  );
}
