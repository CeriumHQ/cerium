import {
  ARTIFACT_COLUMN_WIDTH,
  ARTIFACT_MAX_HEIGHT,
  artifactDocument,
  artifactId,
  artifactTitle,
  fontFaces,
  isLegacyArtifact,
  localFiles,
  localFileType,
  readFrameMessage,
  RENDER_MESSAGE,
  THEME_MESSAGE,
  themeFromTokens,
  themeUpdate,
  withLocalFiles,
  type ArtifactTheme,
} from "@cerium/artifacts";
import legacyCss from "@cerium/artifacts/legacy.css?raw";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import redHatMono from "@fontsource-variable/red-hat-mono/files/red-hat-mono-latin-wght-normal.woff2?inline";
import redHatText from "@fontsource-variable/red-hat-text/files/red-hat-text-latin-wght-normal.woff2?inline";
import { AsyncResult } from "effect/reactivity";
import {
  Download,
  ExternalLink,
  FileCode,
  ImageDown,
  LoaderCircle,
  Maximize2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CustomRendererProps } from "streamdown";

import { artifactFilesAtom, renderArtifact, type ArtifactFile } from "../../backend/files.ts";
import { shellBridge } from "../../backend/shell.ts";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { useMessageBox } from "../composer/messageBox.ts";
import { artifactFileName, download, openInTab } from "./artifactExport.ts";
import { CopyButton } from "./CopyButton.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import { relativePath } from "./paths.ts";

// Agents' HTML visuals. Each renders in a frame sandboxed into an opaque origin, which loads the host
// page (`artifact.html`, served with its own policy) and is sent the agent's page to render, with
// the window's theme; the theme follows the window live, without reloading the page.

/** Height held while the artifact streams and until its frame reports its own. */
const PLACEHOLDER_HEIGHT = 112;

/** The host page, beside index.html in every build. */
const HOST_URL = `${import.meta.env.BASE_URL}artifact.html`;

const FONTS = fontFaces({ sans: redHatText, mono: redHatMono });

const NO_FILES: ReadonlyMap<string, string> = new Map();

/**
 * The height each artifact last reported, so one the transcript mounts again (scrolling back, a
 * reload of the list) opens at its size instead of growing from the placeholder.
 */
const heights = new Map<string, number>();
const rememberHeight = (code: string, height: number) => {
  heights.delete(code);
  heights.set(code, height);
  if (heights.size > 200) heights.delete(heights.keys().next().value!);
};

/** Changes to the mode (`data-theme`) or the palette, which together decide the window's colours. */
const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme", "data-palette"] });
  return () => observer.disconnect();
};

/** The theme last read, by the mode and palette it was read under. */
let readTheme: { readonly under: string; readonly snapshot: string } | undefined;

/**
 * The window's theme as a page sees it, as a string so the same theme compares equal. It's read again
 * only once the mode or palette changes: every frame asks for it on each of its renders, and reading
 * the computed style each time made the browser work out the window's styles again.
 */
const themeSnapshot = (): string => {
  const { dataset } = document.documentElement;
  const under = `${dataset["theme"]}:${dataset["palette"]}`;
  if (readTheme?.under !== under) {
    const style = getComputedStyle(document.documentElement);
    const mode = dataset["theme"] === "light" ? "light" : "dark";
    const theme = themeFromTokens(mode, (token) => style.getPropertyValue(token));
    readTheme = { under, snapshot: JSON.stringify(theme) };
  }
  return readTheme.snapshot;
};

/** An agent's HTML visual: drawn once its code fence closes, with a placeholder while it streams. */
export function Artifact({ code, isIncomplete }: CustomRendererProps) {
  const title = artifactTitle(code);
  if (isIncomplete) return <Drawing title={title} />;
  return <ArtifactView key={code} code={code} title={title} />;
}

function Drawing({
  title,
  height = PLACEHOLDER_HEIGHT,
  className = "",
}: {
  title: string | undefined;
  height?: number;
  className?: string;
}) {
  return (
    <div
      style={{ height }}
      className={`grid place-items-center rounded-[0.625rem] border border-line-subtle bg-surface-hover text-[12.5px] ${className}`}
    >
      <span className="text-shimmer">{title ? `Drawing ${title}…` : "Drawing…"}</span>
    </div>
  );
}

const toolClass =
  "grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary pointer-coarse:size-8";

/** The rendered artifact in the transcript, with its tools on hover and a full-size view. */
function ArtifactView({ code, title }: { code: string; title: string | undefined }) {
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [expanded, setExpanded] = useState(false);
  // The pointer over the frame, which the frame reports: the window's own hover stops at its edge.
  const [pointerInside, setPointerInside] = useState(false);
  const onError = (message: string) =>
    setErrors((current) =>
      current.includes(message) || current.length >= 5 ? current : [...current, message],
    );
  // A choice made in the page goes to the message box for the user to send, in place of the one
  // made before it if that's still there untouched.
  const messageBox = useMessageBox();
  const lastReply = useRef<string>(undefined);
  const onReply = messageBox
    ? (text: string) => {
        messageBox.append({ segments: [{ kind: "text", text }], replacing: lastReply.current });
        lastReply.current = text;
        setExpanded(false);
      }
    : undefined;
  // A saved image is as wide as the artifact in the conversation, whichever view it's saved from.
  const view = useRef<HTMLDivElement>(null);
  const widthOf = () => view.current?.clientWidth || ARTIFACT_COLUMN_WIDTH;

  return (
    <div
      ref={view}
      data-artifact
      // The artifacts panel finds it in the conversation by it.
      data-artifact-id={artifactId(code)}
      {...(pointerInside ? { "data-hover": "" } : {})}
      className="group/artifact relative"
    >
      <ArtifactFrame
        code={code}
        title={title}
        remember
        onError={onError}
        onPointer={setPointerInside}
        onReply={onReply}
      />
      {/* On touch screens, with no hover to reveal them, the tools sit under the page instead of over it. */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-lg border border-line-subtle bg-surface-overlay p-0.5 opacity-0 shadow-raised backdrop-blur-xl transition-opacity duration-150 group-hover/artifact:opacity-100 group-data-hover/artifact:opacity-100 focus-within:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:static pointer-coarse:mt-1 pointer-coarse:ml-auto pointer-coarse:w-fit pointer-coarse:border-0 pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none pointer-coarse:backdrop-blur-none">
        {errors.length > 0 ? (
          <span title={errors.join("\n")} className="grid size-6 place-items-center text-status-attention">
            <TriangleAlert size={13} strokeWidth={2} aria-hidden />
            <span className="sr-only">{`Errors: ${errors.join("; ")}`}</span>
          </span>
        ) : null}
        <CopyButton text={code} label="Copy HTML" />
        <ArtifactMenu code={code} title={title} widthOf={widthOf} onError={onError} />
        <Button aria-label="Expand" title="Expand" onClick={() => setExpanded(true)} className={toolClass}>
          <Maximize2 size={13} strokeWidth={1.75} />
        </Button>
      </div>
      <ArtifactDialog
        code={code}
        title={title}
        open={expanded}
        onOpenChange={setExpanded}
        widthOf={widthOf}
        onError={onError}
        onReply={onReply}
      />
    </div>
  );
}

/** The artifact at full size, over the window, with its tools. */
export function ArtifactDialog({
  code,
  title,
  open,
  onOpenChange,
  widthOf = () => ARTIFACT_COLUMN_WIDTH,
  onError,
  onReply,
}: {
  code: string;
  title: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How wide a saved image is: the artifact's width in the conversation. */
  widthOf?: () => number;
  onError?: (message: string) => void;
  onReply?: ((text: string) => void) | undefined;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex h-[calc(100dvh-4rem)] w-[min(72rem,calc(100vw-4rem))] -translate-1/2 flex-col overflow-hidden rounded-2xl border border-line-subtle bg-surface-overlay shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-4">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-secondary">
              {title ?? "Artifact"}
            </Dialog.Title>
            <CopyButton text={code} label="Copy HTML" />
            <ArtifactMenu
              code={code}
              title={title}
              widthOf={widthOf}
              onError={onError ?? (() => undefined)}
            />
            <Dialog.Close aria-label="Close" className={toolClass}>
              <X size={14} strokeWidth={2} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 py-6">
            <ArtifactFrame code={code} title={title} onReply={onReply} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The artifact drawn small, as the conversation's column shows it scaled to the box's width: only
 * while the box is in or near view, and not to be used.
 */
export function ArtifactThumbnail({
  code,
  title,
  className = "",
}: {
  code: string;
  title: string | undefined;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pageHeight, setPageHeight] = useState(PLACEHOLDER_HEIGHT);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const sizes = new ResizeObserver(() => setWidth(element.clientWidth - THUMBNAIL_INSET * 2));
    sizes.observe(element);
    // The page is drawn as the box comes near view, and its frame goes once the box is far from it:
    // the artifacts panel lists up to 120, each a page running in a frame of its own. `scrollMargin`
    // reaches past the list's own edges, which `rootMargin` stops at; a browser without it leaves each
    // frame drawn.
    const coming = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR, scrollMargin: NEAR },
    );
    coming.observe(element);
    const going =
      "scrollMargin" in IntersectionObserver.prototype
        ? new IntersectionObserver(
            (entries) => {
              if (entries.every((entry) => !entry.isIntersecting)) setNear(false);
            },
            { rootMargin: FAR, scrollMargin: FAR },
          )
        : undefined;
    going?.observe(element);
    return () => {
      sizes.disconnect();
      coming.disconnect();
      going?.disconnect();
    };
  }, []);
  // The box takes the page's height, scaled, up to a limit: a short page doesn't leave it empty.
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const sizes = new ResizeObserver(() => setPageHeight(element.offsetHeight));
    sizes.observe(element);
    return () => sizes.disconnect();
  }, [near, width]);
  const scale = Math.max(width, 0) / ARTIFACT_COLUMN_WIDTH;
  const height = Math.round(
    Math.min(Math.max(pageHeight * scale, THUMBNAIL_MIN), THUMBNAIL_MAX) + THUMBNAIL_INSET * 2,
  );
  return (
    // A mask or filter over the frame would stop it being drawn: the frame runs in a process of its own.
    <div ref={box} inert aria-hidden style={{ height }} className={`relative overflow-hidden ${className}`}>
      {near && width > 0 ? (
        <div
          ref={page}
          style={{ width: ARTIFACT_COLUMN_WIDTH, scale, top: THUMBNAIL_INSET, left: THUMBNAIL_INSET }}
          className="pointer-events-none absolute origin-top-left"
        >
          {/* Drawn again, the page holds the height it had, so the box keeps its size meanwhile. */}
          <ArtifactFrame code={code} title={title} quiet startHeight={pageHeight} />
        </div>
      ) : null}
    </div>
  );
}

/** A thumbnail's room around the page, and the least and most of the page it shows, in its pixels. */
const THUMBNAIL_INSET = 10;
const THUMBNAIL_MIN = 36;
const THUMBNAIL_MAX = 150;

/** How near view a thumbnail's page is drawn, and how far from it its frame goes. */
const NEAR = "200px";
const FAR = "1500px";

/** Room around a page saved as an image, beside the page's own width. */
const SAVED_MARGIN = 24;

/** Saves an artifact's image where the user picks, or downloads it where the window can't ask. */
const savePngAs = async (image: { readonly mediaType: string; readonly data: string }, fileName: string) => {
  const bridge = shellBridge();
  if (bridge?.saveImage) {
    await bridge.saveImage(`data:${image.mediaType};base64,${image.data}`, fileName);
    return;
  }
  const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  download(new Blob([bytes], { type: image.mediaType }), fileName);
};

/** Taking the artifact out of the conversation: an image or a page to keep, or a browser tab. */
function ArtifactMenu({
  code,
  title,
  widthOf,
  onError,
}: {
  code: string;
  title: string | undefined;
  widthOf: () => number;
  onError: (message: string) => void;
}) {
  const files = useArtifactFiles(code);
  const render = useAtomSet(renderArtifact, { mode: "promise" });
  const [saving, setSaving] = useState(false);
  const bridge = shellBridge();
  const name = title ?? "Artifact";
  const standalone = () =>
    artifactDocument(withLocalFiles(code, files ?? NO_FILES), {
      theme: JSON.parse(themeSnapshot()) as ArtifactTheme,
      fonts: FONTS,
      legacyCss,
      standalone: true,
      title: name,
    });

  // Without a `try`, whose `finally` or conditionals would make the React Compiler skip the menu.
  const savePng = async () => {
    const theme = JSON.parse(themeSnapshot()) as ArtifactTheme;
    setSaving(true);
    const payload = {
      html: withLocalFiles(code, files ?? NO_FILES),
      width: Math.round(widthOf()) + SAVED_MARGIN * 2,
      mode: theme.mode,
      variables: theme.variables,
    };
    await render({ payload })
      .then((image) => savePngAs(image, artifactFileName(title, "png")))
      .catch((error: unknown) =>
        onError(`Couldn't save as PNG: ${error instanceof Error ? error.message : String(error)}`),
      );
    setSaving(false);
  };
  const saveHtml = () =>
    download(new Blob([standalone()], { type: "text/html" }), artifactFileName(title, "html"));
  const openInBrowser = () => {
    if (bridge?.openHtml) void bridge.openHtml(standalone(), name);
    else openInTab(standalone(), name, HOST_URL);
  };

  return (
    <MenuRoot>
      <MenuTrigger>
        <button type="button" aria-label="Save or open" title="Save or open" className={toolClass}>
          {saving ? (
            <LoaderCircle size={13} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Download size={13} strokeWidth={1.75} />
          )}
        </button>
      </MenuTrigger>
      <MenuPopup>
        <MenuItem icon={ImageDown} onClick={() => void savePng()} disabled={saving}>
          Save as PNG
        </MenuItem>
        <MenuItem icon={FileCode} onClick={saveHtml}>
          Save as HTML
        </MenuItem>
        <MenuItem icon={ExternalLink} onClick={openInBrowser}>
          Open in browser
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

/**
 * The local files a page names as `data:` URLs, read through the backend; undefined until they are.
 * Images come from anywhere, data files only from inside the thread's folder.
 */
const useArtifactFiles = (code: string): ReadonlyMap<string, string> | undefined => {
  const folder = useContext(WorkspaceFolder);
  const files = localFiles(code).flatMap((path): ReadonlyArray<ArtifactFile> => {
    const type = localFileType(path);
    if (type?.kind === "image") return [{ path, kind: "image" }];
    const relative = type === undefined ? undefined : relativePath(path, folder);
    return type === undefined || folder === undefined || relative === undefined
      ? []
      : [{ path, kind: "data", mediaType: type.mediaType, root: folder, relative }];
  });
  const read = useAtomValue(artifactFilesAtom(JSON.stringify(files)));
  if (AsyncResult.isSuccess(read)) return read.value;
  return AsyncResult.isFailure(read) ? NO_FILES : undefined;
};

/**
 * The frame itself, as tall as the page inside it. `remember` keeps its height for the next time the
 * transcript mounts it; the full-size view, at another width, leaves it alone.
 */
function ArtifactFrame({
  code,
  title,
  remember = false,
  quiet = false,
  startHeight,
  onError,
  onPointer,
  onReply,
}: {
  code: string;
  title: string | undefined;
  remember?: boolean;
  /** Nothing shows until the page is drawn, for a page shown too small to read "Drawing…". */
  quiet?: boolean;
  /** The height held until the page reports its own, in place of the placeholder's. */
  startHeight?: number;
  onError?: (message: string) => void;
  onPointer?: (inside: boolean) => void;
  onReply?: ((text: string) => void) | undefined;
}) {
  const themeKey = useSyncExternalStore(subscribeTheme, themeSnapshot);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(() => (remember ? heights.get(code) : startHeight));
  const [drawn, setDrawn] = useState(false);
  const [hostReady, setHostReady] = useState(false);
  const rendered = useRef(false);
  const legacy = isLegacyArtifact(code);
  // The local files the page names, read through the backend before it renders: the page itself
  // can't load a file. Ones that can't be read keep their path and fail in the page.
  const filesRead = useArtifactFiles(code);

  // The page renders once, when both the host page and its files are ready; theme changes after
  // that restyle it in place (below).
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!target || !hostReady || filesRead === undefined || rendered.current) return;
    rendered.current = true;
    const theme = JSON.parse(themeKey) as ArtifactTheme;
    const html = artifactDocument(withLocalFiles(code, filesRead), { theme, fonts: FONTS, legacyCss });
    target.postMessage({ type: RENDER_MESSAGE, html }, "*");
  }, [code, hostReady, filesRead, themeKey]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const message = readFrameMessage(event.data);
      switch (message?.kind) {
        case "ready":
          setHostReady(true);
          return;
        case "height": {
          const next = Math.min(Math.max(Math.ceil(message.height), 1), ARTIFACT_MAX_HEIGHT);
          setHeight(next);
          setDrawn(true);
          if (remember) rememberHeight(code, next);
          return;
        }
        case "link":
          window.open(message.url, "_blank", "noopener,noreferrer");
          return;
        case "key": {
          const { kind: _kind, ...init } = message;
          document.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
          return;
        }
        case "error":
          onError?.(message.message);
          return;
        case "pointer":
          onPointer?.(message.inside);
          return;
        case "reply":
          onReply?.(message.text);
          return;
        default:
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [code, remember, onError, onPointer, onReply]);

  // A new theme goes to the page, which restyles in place. Before the page is drawn, the host page
  // ignores it and the page starts in the theme it's sent with.
  useEffect(() => {
    const theme = JSON.parse(themeKey) as ArtifactTheme;
    frame.current?.contentWindow?.postMessage(
      { type: THEME_MESSAGE, theme: themeUpdate(theme, legacy) },
      "*",
    );
  }, [themeKey, legacy]);

  return (
    <div className="relative">
      <iframe
        ref={frame}
        title={title ?? "Artifact"}
        src={HOST_URL}
        sandbox="allow-scripts allow-forms"
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        style={{ height: height ?? PLACEHOLDER_HEIGHT }}
        className={`block w-full border-0 bg-transparent transition-opacity duration-150 ${drawn ? "opacity-100" : "opacity-0"}`}
      />
      {drawn || quiet ? null : (
        <Drawing
          title={title}
          height={height ?? PLACEHOLDER_HEIGHT}
          className="pointer-events-none absolute inset-x-0 top-0"
        />
      )}
    </div>
  );
}
