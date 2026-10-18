import { Dialog } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { ImageOff, X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { imageAtom } from "../backend/files.ts";

interface ThumbProps {
  /** What the image is, for its alt text and the enlarged view's caption. */
  readonly name: string;
  /** Size and shape of the thumbnail, such as `h-28 max-w-60` or `size-6`. */
  readonly className: string;
}

/** An image shown small; clicking opens it at full size over the window. */
export function ImageThumb({ url, name, className }: ThumbProps & { url: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        aria-label={`Enlarge ${name}`}
        className={`group/thumb relative shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line-subtle bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          className="size-full object-cover transition-[filter] duration-150 group-hover/thumb:brightness-110"
        />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-w-[calc(100vw-4rem)] -translate-1/2 flex-col items-center gap-2.5 transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <img
            src={url}
            alt={name}
            className="max-h-[calc(100vh-8rem)] max-w-full rounded-xl border border-line-subtle object-contain shadow-overlay"
          />
          <Dialog.Title className="max-w-full truncate text-xs text-fg-secondary">{name}</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            className="absolute -top-3 -right-3 grid size-7 place-items-center rounded-full border border-line-subtle bg-surface-overlay text-fg-secondary shadow-overlay backdrop-blur-xl transition-colors hover:text-fg-primary"
          >
            <X size={14} strokeWidth={2} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** An image file on disk, read through the backend, as a thumbnail. */
export function FileImageThumb({ path, name, className }: ThumbProps & { path: string }) {
  const result = useAtomValue(imageAtom(path));
  if (AsyncResult.isSuccess(result))
    return <ImageThumb url={result.value} name={name} className={className} />;
  return (
    <span
      title={AsyncResult.isFailure(result) ? `${name} couldn't be shown` : name}
      className={`grid shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-hover text-fg-tertiary ${
        AsyncResult.isFailure(result) ? "" : "animate-pulse"
      } ${className}`}
    >
      {AsyncResult.isFailure(result) ? <ImageOff size={14} strokeWidth={1.75} /> : null}
    </span>
  );
}
