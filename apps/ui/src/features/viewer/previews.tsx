import { useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Maximize2, Minimize2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { DefaultComponents } from "streamdown";

import { mediaAtom, mediaKey, previewAtom, previewKey } from "../../backend/explorer.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { MessageBoxContext, type MessageBox } from "../composer/messageBox.ts";
import type { OpenFile } from "../files/model.ts";
import { WorkspaceFolder } from "../transcript/FileChip.tsx";
import { Markdown } from "../transcript/Markdown.tsx";
import { byteSize } from "./model.ts";

// How the viewer shows a file as it renders, rather than as its text: Markdown, a web page, an SVG,
// an image, a sound or a video.

export const messageOf = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : fallback;
};

/** What fills the viewer when there is nothing to show: a line saying why, and what to do instead. */
export function Note({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-body text-fg-tertiary max-md:text-[14px]">
      <div className="flex max-w-80 flex-col items-center gap-3 text-pretty">
        <p>{children}</p>
        {action}
      </div>
    </div>
  );
}

/** A transparent image's backdrop: the neutral checkerboard image editors use. */
const checkerboard = {
  backgroundImage:
    "conic-gradient(var(--surface-active) 25%, transparent 0 50%, var(--surface-active) 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
} as const;

/** An image fitted to the viewer, or at its own size to scroll around; a click switches. */
function ImageFrame({ src, name, footer }: { src: string; name: string; footer: ReactNode }) {
  const [actual, setActual] = useState(false);
  const [dimensions, setDimensions] = useState<string>();
  return (
    <div className="relative flex h-full flex-col">
      <div className="absolute top-2 right-3 z-10">
        <IconButton
          icon={actual ? Minimize2 : Maximize2}
          label={actual ? "Fit to the window" : "Actual size"}
          onClick={() => setActual(!actual)}
        />
      </div>
      <div
        className={`scroll-thin min-h-0 flex-1 overflow-auto p-8 ${actual ? "" : "grid place-items-center [container-type:size]"}`}
      >
        <button
          type="button"
          onClick={() => setActual(!actual)}
          aria-label={actual ? "Fit to the window" : "Show at actual size"}
          className={`block rounded-md border border-line-subtle ${actual ? "cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in"}`}
          style={checkerboard}
        >
          <img
            src={src}
            alt={name}
            draggable={false}
            onLoad={(event) =>
              setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)
            }
            className={`block select-none ${actual ? "max-w-none" : "max-h-[calc(100cqh-2px)] max-w-full object-contain"}`}
          />
        </button>
      </div>
      <p className="shrink-0 px-4 pb-3 text-center text-meta text-fg-tertiary tabular-nums">
        {dimensions ? `${dimensions} · ` : ""}
        {footer}
      </p>
    </div>
  );
}

/** A media file's bytes on their way in, as a bar that fills. */
function Loading({ received, size }: { received: number; size: number }) {
  const share = size === 0 ? 0 : Math.min(1, received / size);
  return (
    <Note>
      <span className="flex w-56 flex-col items-center gap-2">
        <span className="h-1 w-full overflow-hidden rounded-full bg-surface-active">
          <span
            className="block h-full rounded-full bg-fg-secondary transition-[width] duration-200"
            style={{ width: `${share * 100}%` }}
          />
        </span>
        <span className="text-meta tabular-nums">
          {byteSize(received)} of {byteSize(size)}
        </span>
      </span>
    </Note>
  );
}

/** An image, a sound or a video, read from the machine in pieces and then shown or played here. */
export function MediaPreview({
  root,
  path,
  kind,
  mediaType,
  size,
}: {
  root: string;
  path: string;
  kind: "image" | "audio" | "video";
  mediaType: string;
  size: number;
}) {
  const result = useAtomValue(mediaAtom(mediaKey(root, path, mediaType)));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const load = AsyncResult.value(result);
  if (Option.isNone(load)) {
    return AsyncResult.isFailure(result) ? (
      <Note>{messageOf(result.cause, "That file couldn't be read.")}</Note>
    ) : (
      <Loading received={0} size={size} />
    );
  }
  const { url, received } = load.value;
  if (url === undefined) return <Loading received={received} size={size} />;
  if (kind === "image") return <ImageFrame src={url} name={name} footer={byteSize(size)} />;
  if (kind === "audio") {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-line-subtle bg-surface-raised px-6 py-7 shadow-raised">
          <FileIcon path={path} className="size-10" />
          <div className="flex max-w-full flex-col items-center gap-0.5 text-center">
            <span className="max-w-full truncate text-reading font-medium text-fg-primary">{name}</span>
            <span className="text-meta text-fg-tertiary tabular-nums">{byteSize(size)}</span>
          </div>
          {/* The file has no captions to offer; it's the user's own recording or asset. */}
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={url} controls className="w-full" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={url}
          controls
          className="max-h-full max-w-full rounded-md border border-line-subtle bg-scrim"
        />
      </div>
      <p className="shrink-0 px-4 pb-3 text-center text-meta text-fg-tertiary tabular-nums">
        {byteSize(size)}
      </p>
    </div>
  );
}

/**
 * `svg` with the width and height its `viewBox` gives when it sets neither: an image with no size of
 * its own draws at none in a frame that fits around it.
 */
export const sizedSvg = (svg: string): string => {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (open === null || /\s(width|height)\s*=/i.test(open[0])) return svg;
  const box = /\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(
    open[0],
  );
  if (box === null) return svg;
  const at = open.index + 4;
  return `${svg.slice(0, at)} width="${box[1]}" height="${box[2]}"${svg.slice(at)}`;
};

/** An SVG drawn as an image, which runs none of its scripts. */
export function SvgPreview({ text, path, size }: { text: string; path: string; size: number }) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <ImageFrame
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg(text))}`}
      name={name}
      footer={byteSize(size)}
    />
  );
}

/**
 * Where `src` points in the thread's folder, when it's a path relative to the Markdown file `path`,
 * or to the folder itself when it starts with `/`, as on GitHub.
 */
export const relativeTarget = (src: string, path: string): string | undefined => {
  if (/^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(src)) return undefined;
  const parts = src.startsWith("/") ? [] : path.split("/").slice(0, -1);
  const [target = ""] = src.split(/[?#]/);
  for (const part of decodeURI(target).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("/");
};

/** A path hardening percent-encoded, as it is on disk. */
const folderPath = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

/** How a Markdown image asks to be drawn: its text, and the size it may set. */
interface Shown {
  readonly alt: string;
  readonly width: string | number | undefined;
  readonly height: string | number | undefined;
}

/** An image in a Markdown file, held to the column's width. */
const MarkdownImage = ({ src, shown }: { src: string; shown: Shown }) => (
  <img
    src={src}
    alt={shown.alt}
    width={shown.width}
    height={shown.height}
    className="inline-block h-auto max-w-full"
  />
);

/** An image a Markdown file links from beside it in the folder, read through the machine. */
function FolderImage({ root, path, shown }: { root: string; path: string; shown: Shown }) {
  const preview = AsyncResult.value(useAtomValue(previewAtom(previewKey(root, path))));
  const file = Option.getOrUndefined(preview);
  if (file?._tag === "Text" && path.toLowerCase().endsWith(".svg")) {
    return (
      <MarkdownImage
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`}
        shown={shown}
      />
    );
  }
  if (file?._tag !== "Media" || file.kind !== "image") {
    return <span className="text-fg-tertiary">{shown.alt}</span>;
  }
  return <FolderMedia root={root} path={path} mediaType={file.mediaType} shown={shown} />;
}

function FolderMedia({
  root,
  path,
  mediaType,
  shown,
}: {
  root: string;
  path: string;
  mediaType: string;
  shown: Shown;
}) {
  const load = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(mediaAtom(mediaKey(root, path, mediaType)))),
  );
  return load?.url ? (
    <MarkdownImage src={load.url} shown={shown} />
  ) : (
    <span className="text-fg-tertiary">{shown.alt}</span>
  );
}

/** A Markdown file as it reads, its relative images drawn from the folder. */
export function MarkdownPreview({
  root,
  path,
  text,
  messageBox,
  onOpenFile,
}: {
  root: string;
  path: string;
  text: string;
  messageBox: MessageBox | undefined;
  onOpenFile: OpenFile | undefined;
}) {
  // Relative images and links reach the renderer as `/` and their path in the folder, which
  // hardening keeps.
  const resolve = (address: string) => {
    const target = relativeTarget(address, path);
    return target === undefined ? undefined : `/${target}`;
  };
  const inFolder = (address: unknown) =>
    typeof address === "string" && address.startsWith("/") && !address.startsWith("//")
      ? folderPath(address.slice(1))
      : undefined;
  const image: DefaultComponents["img"] = ({ src, alt, width, height }) => {
    if (typeof src !== "string") return null;
    const shown = { alt: alt ?? "", width, height };
    const target = inFolder(src);
    return target === undefined ? (
      <MarkdownImage src={src} shown={shown} />
    ) : (
      <FolderImage root={root} path={target} shown={shown} />
    );
  };
  const link = ({ href, children }: { href?: string | undefined; children?: ReactNode }) => {
    const target = inFolder(href);
    if (target === undefined) return undefined;
    if (onOpenFile === undefined) return <span className="font-medium">{children}</span>;
    return (
      <button
        type="button"
        title={target}
        onClick={() => onOpenFile(target)}
        onAuxClick={(event) => {
          if (event.button === 1) onOpenFile(target);
        }}
        className="cursor-pointer font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
      >
        {children}
      </button>
    );
  };
  return (
    <div className="scroll-thin h-full overflow-auto select-text">
      <article className="mx-auto max-w-3xl px-8 py-8 max-md:px-4 max-md:py-5">
        <WorkspaceFolder value={root}>
          <MessageBoxContext value={messageBox}>
            <Markdown text={text} streaming={false} folder={{ resolve, image, link }} />
          </MessageBoxContext>
        </WorkspaceFolder>
      </article>
    </div>
  );
}

/**
 * A web page's own HTML in a sandboxed frame with an opaque origin and a policy that admits no script
 * and no request: its layout and styles show, while nothing an agent wrote into it can run or reach
 * out. Files it links beside it don't load.
 */
export const htmlDocument = (html: string): string => {
  const policy =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return html.slice(0, head.index + head[0].length) + policy + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<head>${policy}</head>${html.slice(at)}`;
};

export function HtmlPreview({ text, path }: { text: string; path: string }) {
  return (
    <div className="h-full p-3">
      <iframe
        title={path}
        sandbox=""
        srcDoc={htmlDocument(text)}
        referrerPolicy="no-referrer"
        className="size-full rounded-lg border border-line-subtle bg-[Canvas] [color-scheme:light]"
      />
    </div>
  );
}
