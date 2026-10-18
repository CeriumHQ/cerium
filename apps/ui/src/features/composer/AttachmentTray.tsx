import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CircleAlert, ImageOff, LoaderCircle, X } from "lucide-react";

import { imageAtom } from "../../backend/files.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { ImageThumb } from "../../components/ImageThumb.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import type { DraftAttachment } from "./draft.ts";

/** The files attached to the draft, above its text: images as thumbnails, other files as cards. */
export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: ReadonlyArray<DraftAttachment>;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group/tile relative">
          {attachment.preview ? (
            <ImageThumb url={attachment.preview} name={attachment.name} className="size-14" />
          ) : attachment.mediaType.startsWith("image/") && attachment.state._tag === "Ready" ? (
            <SavedImage path={attachment.state.attachment.path} name={attachment.name} />
          ) : (
            <div className="flex h-14 max-w-52 items-center gap-2 rounded-lg border border-line-subtle bg-surface-hover pr-3 pl-2.5">
              <FileIcon path={attachment.name} className="size-6" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12.5px] font-medium text-fg-primary">{attachment.name}</span>
                <span className="text-2xs text-fg-tertiary uppercase">
                  {attachment.name.includes(".") ? attachment.name.split(".").at(-1) : "File"}
                </span>
              </div>
            </div>
          )}
          {attachment.state._tag === "Preparing" ? (
            <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-scrim">
              <LoaderCircle size={16} className="animate-spin text-fg-primary" />
            </span>
          ) : attachment.state._tag === "Failed" ? (
            <Tooltip label={attachment.state.message} side="top">
              <span className="absolute inset-0 grid place-items-center rounded-lg border border-error/60 bg-scrim text-error">
                <CircleAlert size={16} strokeWidth={2} />
              </span>
            </Tooltip>
          ) : null}
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line-strong bg-surface-overlay text-fg-secondary opacity-0 shadow-raised transition-opacity group-hover/tile:opacity-100 hover:text-fg-primary focus-visible:opacity-100"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** An image attached from a sent message, which is already on disk rather than in the window. */
function SavedImage({ path, name }: { path: string; name: string }) {
  const result = useAtomValue(imageAtom(path));
  return AsyncResult.isSuccess(result) ? (
    <ImageThumb url={result.value} name={name} className="size-14" />
  ) : (
    <span
      title={AsyncResult.isFailure(result) ? `${name} couldn't be shown` : name}
      className={`grid size-14 place-items-center rounded-lg border border-line-subtle bg-surface-hover text-fg-tertiary ${
        AsyncResult.isFailure(result) ? "" : "animate-pulse"
      }`}
    >
      {AsyncResult.isFailure(result) ? <ImageOff size={14} strokeWidth={1.75} /> : null}
    </span>
  );
}
