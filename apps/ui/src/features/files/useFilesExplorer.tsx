import type { AgentEvent } from "@cerium/protocol";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { applyChanges, expandedAtom, watchAtom } from "../../backend/explorer.ts";
import { useCompact } from "../../app/compact.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import { FilePreview } from "./FilePreview.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { noTouched, touchedFiles, touchedKey } from "./model.ts";

/** What the window needs of the file explorer: the panel, the preview over the conversation, and whether either is up. */
export interface FilesExplorer {
  /** The files panel, while it is open. */
  readonly panel: ReactNode | undefined;
  /** The open file over the conversation, in a window wide enough for that. */
  readonly overlay: ReactNode | undefined;
  /** A file is open in the preview. */
  readonly previewing: boolean;
  /** Closes the preview. */
  readonly closePreview: () => void;
}

/**
 * The explorer of a thread's folder `root`: which file is open, and keeping what it shows current.
 * While the panel or a preview is up, the machine says what changes under `root`, and the files this
 * thread's agents report changing are read again at once, so what's on screen follows their work.
 */
export function useFilesExplorer({
  root,
  events,
  messageBox,
  open,
  onClose,
}: {
  /** The thread's folder; none where there is nothing to browse. */
  root: string | undefined;
  /** The thread's events, for the files its agents changed. */
  events: ReadonlyArray<AgentEvent>;
  messageBox: MessageBox | undefined;
  /** The files panel is shown. */
  open: boolean;
  onClose: () => void;
}): FilesExplorer {
  const registry = useContext(RegistryContext);
  const compact = useCompact();
  const [shown, setShown] = useState<{ readonly root: string; readonly path: string }>();
  // In the narrow window a file lives in the panel's pane, so closing the panel closes it too.
  if (compact && !open && shown !== undefined) setShown(undefined);
  const file = root !== undefined && shown?.root === root ? shown.path : undefined;
  const active = root !== undefined && (open || file !== undefined);
  const touched = active ? touchedFiles(events, root) : noTouched;

  // The machine says what changed under the folder, in batches.
  const onBatch = useEffectEvent((batch: Parameters<typeof applyChanges>[2]) => {
    if (root !== undefined)
      applyChanges(registry, root, batch, { expanded: registry.get(expandedAtom(root)), file });
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

  const closePreview = () => setShown(undefined);
  const touch = file === undefined ? undefined : touched.files.get(touchedKey(touched, file))?.change;
  const preview =
    root !== undefined && file !== undefined ? (
      <FilePreview
        key={file}
        root={root}
        path={file}
        touch={touch}
        variant={compact ? "pane" : "overlay"}
        onClose={closePreview}
        messageBox={messageBox}
      />
    ) : undefined;

  return {
    panel:
      open && root !== undefined ? (
        <FilesPanel
          root={root}
          touched={touched}
          selected={file}
          messageBox={messageBox}
          preview={compact ? preview : undefined}
          onOpenFile={(path) => setShown({ root, path })}
          onClose={onClose}
        />
      ) : undefined,
    overlay: compact ? undefined : preview,
    previewing: file !== undefined,
    closePreview,
  };
}
