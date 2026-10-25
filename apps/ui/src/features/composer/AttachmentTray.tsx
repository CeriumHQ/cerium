import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CircleAlert, ImageOff, LoaderCircle, X } from "lucide-react";

import { imageAtom } from "../../backend/files.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { ImageThumb } from "../../components/ImageThumb.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useLingering } from "../../lib/motion.ts";
import type { DraftAttachment } from "./draft.ts";

/** The files attached to the draft, above its text: images as thumbnails, other files as cards. */
export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: ReadonlyArray<DraftAttachment>;
  onRemove: (id: string) => void;
}) {
  // A file that couldn't be attached is left out of the message, so it says why where a touch
  // screen can read it, without a hover.
  const failures = attachments.flatMap((attachment) =>
    attachment.state._tag === "Failed" ? [attachment.state.message] : [],
  );
  // A file pops in as it's attached and out as it's removed.
  const [tiles, release] = useLingering(attachments, (attachment) => attachment.id);
  // A dozen files would push the text off the screen: the tray stops at two rows and a peek of the
  // third, and scrolls from there.
  return (
    <>
      <ScrollArea viewportClassName="max-h-40">
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {tiles.map(({ key, item: attachment, present }) => (
            <Reveal key={key} kind="pop" onGone={() => release(key)}>
              {present ? (
                <div className="group/tile relative">
                  {attachment.preview ? (
                    <ImageThumb url={attachment.preview} name={attachment.name} className="size-14" />
                  ) : attachment.mediaType.startsWith("image/") && attachment.state._tag === "Ready" ? (
                    <SavedImage path={attachment.state.attachment.path} name={attachment.name} />
                  ) : (
                    <div className="flex h-14 max-w-52 items-center gap-2 rounded-lg border border-line-subtle bg-surface-hover pr-3 pl-2.5">
                      <FileIcon path={attachment.name} className="size-6" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-meta font-medium text-fg-primary">
                          {attachment.name}
                        </span>
                        <span className="text-caption text-fg-tertiary uppercase">
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
                  {/* Shown at rest on a touch screen, which has no hover to bring it out. */}
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onRemove(attachment.id)}
                    className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line-strong bg-surface-overlay text-fg-secondary opacity-0 shadow-raised transition-opacity group-hover/tile:opacity-100 hover:text-fg-primary focus-visible:opacity-100 pointer-coarse:opacity-100"
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </div>
              ) : null}
            </Reveal>
          ))}
        </div>
      </ScrollArea>
      {failures[0] === undefined ? null : (
        <p className="px-4 pt-2 text-meta text-error">
          {failures[0]}
          {failures.length > 1 ? ` ${failures.length - 1} more failed too.` : ""}
        </p>
      )}
    </>
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
