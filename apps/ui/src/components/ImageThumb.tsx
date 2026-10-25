import { useAtomValue } from "@effect/atom-react";
import { ImageOff } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import type { ToolImageRef } from "@cerium/protocol";
import { useState } from "react";

import { imageAtom, toolImageAtom } from "../backend/files.ts";
import { ImageViewer, useGallery, WithImageMenu } from "./ImageViewer.tsx";

interface ThumbProps {
  /** What the image is, for its alt text and the enlarged view's caption. */
  readonly name: string;
  /** The image's key in the gallery around it, which opens the viewer among the gallery's images. */
  readonly galleryKey?: string;
  /** Size and shape of the thumbnail, such as `h-28 max-w-60` or `size-6`. */
  readonly className: string;
  /**
   * `crop` fills the box and trims what doesn't fit; `natural` takes the box's height and keeps the
   * image's own proportions, so a thumbnail of a screenshot isn't a strip of it.
   */
  readonly fit?: "crop" | "natural";
}

/**
 * An image shown small; clicking opens it over the whole window, among the rest of its gallery's
 * images when `galleryKey` names it in one. `menu` adds a right-click menu (the composer's attachment
 * tiles go without); `path` is the file behind the image, if any.
 */
export function ImageThumb({
  url,
  name,
  className,
  fit = "crop",
  path,
  menu = false,
  galleryKey,
}: ThumbProps & { url: string; path?: string; menu?: boolean }) {
  const gallery = useGallery();
  const [open, setOpen] = useState<boolean>();
  const image = { key: galleryKey ?? "image", name, url, ...(path === undefined ? {} : { path }) };
  return (
    <>
      <WithImageMenu menu={menu} url={url} name={name} path={path}>
        <button
          type="button"
          aria-label={`Enlarge ${name}`}
          onClick={() => (gallery && galleryKey !== undefined ? gallery.show(image) : setOpen(true))}
          className={`group/thumb relative shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line-subtle bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
        >
          {/* A screenshot is decoded whole for its thumbnail: off the main thread, and only once a
              transcript scrolls near it. */}
          <img
            src={url}
            alt={name}
            draggable={false}
            decoding="async"
            loading="lazy"
            className={`object-cover transition-[filter] duration-150 group-hover/thumb:brightness-110 ${
              fit === "natural" ? "h-full w-auto max-w-full" : "size-full"
            }`}
          />
        </button>
      </WithImageMenu>
      {/* Mounted from the first click until it has closed, rather than a dialog per thumbnail. */}
      {open === undefined ? null : (
        <ImageViewer
          images={[image]}
          current={image.key}
          open={open}
          menu={menu}
          onCurrentChange={() => undefined}
          onOpenChange={setOpen}
          onClosed={() => setOpen(undefined)}
        />
      )}
    </>
  );
}

/**
 * An image file on disk, read through the backend, as a thumbnail. A file that can't be read shows
 * as a labelled placeholder, or, when `quiet`, as nothing at all.
 */
export function FileImageThumb({
  path,
  quiet = false,
  ...thumb
}: ThumbProps & { path: string; quiet?: boolean }) {
  return <LoadedImageThumb {...thumb} result={useAtomValue(imageAtom(path))} path={path} quiet={quiet} />;
}

/**
 * An image of a tool's output that the thread's history left out, read through the backend, as a
 * thumbnail; one that can't be read, such as one kept on a computer that isn't driven, shows as a
 * labelled placeholder, or, when `quiet`, as nothing at all.
 */
export function ToolOutputImageThumb({
  imageRef,
  quiet = false,
  ...thumb
}: ThumbProps & { imageRef: ToolImageRef; quiet?: boolean }) {
  return (
    <LoadedImageThumb
      {...thumb}
      result={useAtomValue(toolImageAtom(JSON.stringify(imageRef)))}
      quiet={quiet}
    />
  );
}

/** An image the backend reads, as a thumbnail once read. */
function LoadedImageThumb({
  result,
  path,
  name,
  className,
  fit,
  galleryKey,
  quiet,
}: ThumbProps & { result: AsyncResult.AsyncResult<string, unknown>; path?: string; quiet: boolean }) {
  if (AsyncResult.isSuccess(result)) {
    return (
      <ImageThumb
        url={result.value}
        name={name}
        className={className}
        {...(fit ? { fit } : {})}
        {...(path === undefined ? {} : { path })}
        {...(galleryKey === undefined ? {} : { galleryKey })}
        menu
      />
    );
  }
  if (AsyncResult.isFailure(result)) {
    if (quiet) return null;
    return (
      <span
        title={path ?? name}
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-line-subtle bg-surface-hover px-2 text-meta text-fg-tertiary"
      >
        <ImageOff size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0 truncate">{name} can't be shown</span>
      </span>
    );
  }
  return (
    <span
      title={name}
      className={`grid shrink-0 animate-pulse place-items-center rounded-lg border border-line-subtle bg-surface-hover ${className}`}
    />
  );
}
