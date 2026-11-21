import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent, useState, type RefObject } from "react";

import { holdRenderer } from "../../desktop/hibernation.ts";
import { saveAttachment } from "../../backend/files.ts";
import { isPreviewable, mediaTypeOf, prepareAttachment } from "./attachments.ts";
import { type Draft, type DraftAttachment } from "./draft.ts";

export function useComposerAttachments({
  draftKey,
  attachments,
  box,
  updateDraft,
  restoreEditorFocus,
}: {
  readonly draftKey: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
  readonly box: RefObject<HTMLDivElement | null>;
  readonly updateDraft: (key: string, update: (draft: Draft) => Draft) => void;
  readonly restoreEditorFocus: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [dragging, setDragging] = useState(false);
  const setAttachment = (key: string, id: string, state: DraftAttachment["state"]) =>
    updateDraft(key, (current) => ({
      ...current,
      attachments: current.attachments.map((attachment) =>
        attachment.id === id ? { ...attachment, state } : attachment,
      ),
    }));

  /** Attaches pasted, dropped or picked files; each shows at once and is ready once it is on disk. */
  const addFiles = (files: ReadonlyArray<File>) => {
    const key = draftKey;
    for (const file of files) {
      const id = crypto.randomUUID();
      const preview = isPreviewable(file) ? URL.createObjectURL(file) : undefined;
      updateDraft(key, (current) => ({
        ...current,
        attachments: [
          ...current.attachments,
          {
            id,
            name: file.name || "Pasted image",
            mediaType: mediaTypeOf(file),
            ...(preview ? { preview } : {}),
            state: { _tag: "Preparing" },
          },
        ],
      }));
      const release = holdRenderer();
      void prepareAttachment(file, (payload) => saveAttachment(registry, id, payload))
        .then(
          (attachment) => setAttachment(key, id, { _tag: "Ready", attachment }),
          (error: unknown) =>
            setAttachment(key, id, {
              _tag: "Failed",
              message: error instanceof Error ? error.message : `${file.name} couldn't be attached.`,
            }),
        )
        .finally(release);
    }
  };

  // Files dropped anywhere on the window attach here, not only onto the box: elsewhere the browser
  // would open the file in place of the app. While the box is out of view (settings or another pane
  // over it, which keep its layout but make it inert, or a dialog hiding it), drops are left alone.
  const takeFiles = useEffectEvent((files: ReadonlyArray<File>) => addFiles(files));
  useEffect(() => {
    const showing = () =>
      box.current !== null &&
      box.current.getClientRects().length > 0 &&
      box.current.closest('[inert], [aria-hidden="true"]') === null;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event) || !showing()) return;
      event.preventDefault();
      setDragging(true);
    };
    // Leaving for the window's edge; moving between its elements names the one entered.
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      setDragging(false);
      if (!carriesFiles(event) || !showing()) return;
      event.preventDefault();
      takeFiles([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [box]);

  const removeAttachment = (id: string) => {
    restoreEditorFocus();
    const removed = attachments.find((attachment) => attachment.id === id);
    if (removed?.preview) URL.revokeObjectURL(removed.preview);
    updateDraft(draftKey, (current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
  };

  return { addFiles, removeAttachment, dragging };
}
