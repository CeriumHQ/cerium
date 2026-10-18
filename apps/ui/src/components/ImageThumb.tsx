import { Dialog } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { Copy, Download, FolderOpen, ImageOff, X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement } from "react";

import { imageAtom } from "../backend/files.ts";
import { shellBridge } from "../backend/shell.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "./ui/Menu.tsx";

interface ThumbProps {
  /** What the image is, for its alt text and the enlarged view's caption. */
  readonly name: string;
  /** Size and shape of the thumbnail, such as `h-28 max-w-60` or `size-6`. */
  readonly className: string;
}

/** The image as a PNG on the clipboard: drawn on a canvas, so any format the page can show works. */
const copyImage = async (url: string) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (png) await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
};

/** `name` with an extension, taken from the data URL's type when the name has none. */
const fileNameFor = (name: string, url: string) => {
  if (/\.[a-z\d]{2,5}$/i.test(name)) return name;
  const type = /^data:image\/([a-z\d.+-]+)/i.exec(url)?.[1]?.toLowerCase();
  const extension = type === "jpeg" ? "jpg" : type === "svg+xml" ? "svg" : (type ?? "png");
  return `${name}.${extension}`;
};

/** What a right-click on an image offers: copy it, find its file, or save a copy. */
function ImageMenu({ url, name, path }: { url: string; name: string; path: string | undefined }) {
  const bridge = shellBridge();
  const reveal = path ? bridge?.revealPath : undefined;
  const save = bridge?.saveImage;
  return (
    <>
      <MenuItem icon={Copy} onClick={() => void copyImage(url).catch(() => undefined)}>
        Copy image
      </MenuItem>
      {reveal || save ? <MenuSeparator /> : null}
      {reveal && path ? (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(path)}>
          Show in File Explorer
        </MenuItem>
      ) : null}
      {save ? (
        <MenuItem
          icon={Download}
          onClick={() => void save(path ?? url, fileNameFor(name, url)).catch(() => undefined)}
        >
          Save image as…
        </MenuItem>
      ) : null}
    </>
  );
}

/** Adds the image menu to `children` (one element) when the image has one. */
function WithImageMenu({
  menu,
  url,
  name,
  path,
  children,
}: {
  menu: boolean;
  url: string;
  name: string;
  path: string | undefined;
  children: ReactElement;
}) {
  return menu ? (
    <ContextMenuArea menu={<ImageMenu url={url} name={name} path={path} />}>{children}</ContextMenuArea>
  ) : (
    children
  );
}

/**
 * An image shown small; clicking opens it at full size over the window. `menu` adds a right-click
 * menu (the composer's attachment tiles go without); `path` is the file behind the image, if any.
 */
export function ImageThumb({
  url,
  name,
  className,
  path,
  menu = false,
}: ThumbProps & { url: string; path?: string; menu?: boolean }) {
  return (
    <Dialog.Root>
      <WithImageMenu menu={menu} url={url} name={name} path={path}>
        <Dialog.Trigger
          aria-label={`Enlarge ${name}`}
          className={`group/thumb relative shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line-subtle bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-accent data-popup-open:brightness-110 ${className}`}
        >
          <img
            src={url}
            alt={name}
            draggable={false}
            className="size-full object-cover transition-[filter] duration-150 group-hover/thumb:brightness-110"
          />
        </Dialog.Trigger>
      </WithImageMenu>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-w-[calc(100vw-4rem)] -translate-1/2 flex-col items-center gap-2.5 transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <WithImageMenu menu={menu} url={url} name={name} path={path}>
            <img
              src={url}
              alt={name}
              className="max-h-[calc(100vh-8rem)] max-w-full rounded-xl border border-line-subtle object-contain shadow-overlay"
            />
          </WithImageMenu>
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
    return <ImageThumb url={result.value} name={name} className={className} path={path} menu />;
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
