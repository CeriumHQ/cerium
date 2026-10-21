import type { AgentEvent } from "@cerium/protocol";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useRef, type ReactNode } from "react";

import { applyChanges, expandedAtom, watchAtom } from "../../backend/explorer.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import { FilesPanel } from "./FilesPanel.tsx";
import { noTouched, touchedFiles, type OpenFile } from "./model.ts";

/**
 * The files panel of a thread's folder `root`, while it is open, kept current: the machine says what
 * changes under `root`, and the files this thread's agents report changing are read again at once,
 * so what's on screen follows their work.
 */
export function useFilesExplorer({
  root,
  events,
  messageBox,
  open,
  onOpenFile,
  activePath,
  onClose,
  onShowChanges,
}: {
  /** The thread's folder; none where there is nothing to browse. */
  root: string | undefined;
  /** The thread's events, for the files its agents changed. */
  events: ReadonlyArray<AgentEvent>;
  messageBox: MessageBox | undefined;
  /** The files panel is shown. */
  open: boolean;
  /** Opens a file of `root` in the viewer; absent where the machine can't serve one. */
  onOpenFile?: OpenFile | undefined;
  /** The file of `root` the viewer shows. */
  activePath?: string | undefined;
  onClose: () => void;
  /** Opens Source control, which lists what changed where the machine has it, in the Changes tab's place. */
  onShowChanges?: () => void;
}): ReactNode | undefined {
  const registry = useContext(RegistryContext);
  const active = root !== undefined && open;
  const touched = active ? touchedFiles(events, root) : noTouched;

  // The machine says what changed under the folder, in batches.
  const onBatch = useEffectEvent((batch: Parameters<typeof applyChanges>[2]) => {
    if (root !== undefined) applyChanges(registry, root, batch, registry.get(expandedAtom(root)));
  });
  useEffect(() => {
    if (!active || root === undefined) return;
    // An atom isn't read until asked to, so `immediate` is what starts the watching.
    return registry.subscribe(
      watchAtom(root),
      (result) => {
        if (AsyncResult.isSuccess(result)) onBatch(result.value);
      },
      { immediate: true },
    );
  }, [registry, active, root]);

  // An agent's edit shows as the event arrives, ahead of the machine's batch, and wherever the
  // machine can't watch.
  const seen = useRef<{ readonly root: string; readonly counts: ReadonlyMap<string, number> }>(undefined);
  useEffect(() => {
    if (!active || root === undefined) {
      seen.current = undefined;
      return;
    }
    const before = seen.current?.root === root ? seen.current.counts : undefined;
    seen.current = { root, counts: new Map([...touched.files].map(([key, { count }]) => [key, count])) };
    if (before === undefined) return;
    const fresh = [...touched.files]
      .filter(([key, { count }]) => count > (before.get(key) ?? 0))
      .map(([, { path }]) => path);
    if (fresh.length > 0) onBatch({ paths: fresh, status: true });
  }, [touched, active, root]);

  return active ? (
    <FilesPanel
      root={root}
      touched={touched}
      messageBox={messageBox}
      onOpenFile={onOpenFile}
      activePath={activePath}
      onClose={onClose}
      {...(onShowChanges === undefined ? {} : { onShowChanges })}
    />
  ) : undefined;
}
