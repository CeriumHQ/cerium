import { Button } from "@base-ui/react/button";
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { PreviewBounds, PreviewBridge } from "../../backend/shell.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { previewBridge, previewStates, shortUrl, subscribePreviews } from "./model.ts";

/** How far in from the pane's edges the page sits, and how long the pane watches its place after a change. */
const INSET = 6;
const SETTLING_MS = 600;

const sameBox = (a: PreviewBounds | undefined, b: PreviewBounds | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height;

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether something the window draws over its own page covers `area`: a menu, a dialog or the
 * palette, which Base UI portals to the body beside the app's root, or a panel floating over the
 * panes, which says so with `data-floats`. The page sits over the window in a view of its own, so it
 * steps aside for them.
 */
const covered = (area: DOMRect) => {
  for (const layer of document.body.children) {
    if (layer.id === "root" || layer.tagName === "SCRIPT") continue;
    for (const popup of [layer, ...layer.children]) {
      if (overlaps(popup.getBoundingClientRect(), area)) return true;
    }
  }
  for (const panel of document.querySelectorAll("[data-floats]")) {
    if (overlaps(panel.getBoundingClientRect(), area)) return true;
  }
  return false;
};

/**
 * Whether the window hides `element` where it stands: a view another took the place of (settings over
 * the threads) turns inert at once and fades out of sight, keeping its size all the while.
 */
const tucked = (element: HTMLElement) =>
  element.closest("[inert]") !== null ||
  !element.checkVisibility({ visibilityProperty: true, opacityProperty: true });

/**
 * Lays the thread's page over `area` while it shows and nothing covers it, following it as the
 * panes move; a still of the page stands in while something does. Watches its place a moment after
 * anything that may move it (a resize, a pane's transition, a popup), rather than every frame.
 */
function useLaidOver(
  bridge: PreviewBridge,
  threadId: string,
  area: React.RefObject<HTMLDivElement | null>,
  away: boolean,
) {
  const [still, setStill] = useState<string>();
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    let placed: PreviewBounds | undefined;
    let hidden = true;
    let frame = 0;
    let until = 0;
    const check = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const gone = away || rect.width < 2 || rect.height < 2 || tucked(element);
      if (gone || covered(rect)) {
        if (!hidden) {
          hidden = true;
          placed = undefined;
          // Out of sight, the page goes at once. Under a popup, the still is taken before the page
          // goes, so the pane never flashes empty.
          if (gone) bridge.place(threadId, null);
          else
            void bridge.still(threadId).then((image) => {
              setStill(image);
              if (hidden) bridge.place(threadId, null);
            });
        }
      } else {
        const box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        if (hidden || !sameBox(placed, box)) {
          hidden = false;
          placed = box;
          bridge.place(threadId, box);
        }
      }
      if (performance.now() < until) frame = requestAnimationFrame(check);
    };
    const watch = () => {
      until = performance.now() + SETTLING_MS;
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    watch();
    const resized = new ResizeObserver(watch);
    resized.observe(element);
    const layers = new MutationObserver(watch);
    layers.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "data-open", "inert"],
    });
    window.addEventListener("resize", watch);
    document.addEventListener("transitionrun", watch, true);
    document.addEventListener("scroll", watch, true);
    // Anything else that moves it, caught within a moment.
    const slow = setInterval(watch, 1000);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      layers.disconnect();
      window.removeEventListener("resize", watch);
      document.removeEventListener("transitionrun", watch, true);
      document.removeEventListener("scroll", watch, true);
      clearInterval(slow);
      bridge.place(threadId, null);
    };
  }, [bridge, threadId, area, away]);
  return still;
}

const navClass =
  "grid size-7 shrink-0 place-items-center rounded-md text-fg-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-primary active:bg-surface-active disabled:pointer-events-none disabled:text-fg-disabled";

/**
 * A thread's browser: an address bar with back, forward and reload over the page, which the user
 * browses and the thread's agents drive. The page itself is the shell's, laid over the pane. Outside
 * the desktop app it says where the preview runs instead.
 */
export function PreviewPane({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const bridge = previewBridge();
  const states = useSyncExternalStore(subscribePreviews, previewStates);
  const state = states[threadId];
  const [draft, setDraft] = useState<string>();
  const [refused, setRefused] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const url = state?.url ?? "";
  const open = (input: string) => {
    if (bridge === undefined) return;
    void bridge.navigate(threadId, input).then((ok) => {
      setRefused(!ok);
      if (ok) {
        setDraft(undefined);
        field.current?.blur();
      }
    });
  };

  return (
    <section aria-label="Preview" className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line-subtle pr-1.5 pl-1.5 max-md:h-12">
        <Tooltip label="Back">
          <Button
            aria-label="Back"
            disabled={!state?.canGoBack}
            onClick={() => bridge?.go(threadId, "back")}
            className={navClass}
          >
            <ArrowLeft size={15} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Tooltip label="Forward">
          <Button
            aria-label="Forward"
            disabled={!state?.canGoForward}
            onClick={() => bridge?.go(threadId, "forward")}
            className={navClass}
          >
            <ArrowRight size={15} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Tooltip label={state?.loading ? "Stop" : "Reload"}>
          <Button
            aria-label={state?.loading ? "Stop" : "Reload"}
            disabled={url === ""}
            onClick={() => bridge?.go(threadId, state?.loading ? "stop" : "reload")}
            className={navClass}
          >
            {state?.loading ? <X size={15} strokeWidth={1.75} /> : <RotateCw size={14} strokeWidth={1.75} />}
          </Button>
        </Tooltip>
        <form
          className="mx-1 flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            open(draft ?? url);
          }}
        >
          <input
            ref={field}
            value={draft ?? (url === "" ? "" : shortUrl(url))}
            onFocus={(event) => {
              setDraft(draft ?? url);
              event.currentTarget.select();
            }}
            onBlur={() => {
              if (draft === url) setDraft(undefined);
            }}
            onChange={(event) => {
              setRefused(false);
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setDraft(undefined);
              setRefused(false);
              event.currentTarget.blur();
            }}
            disabled={bridge === undefined}
            placeholder="localhost:5173"
            aria-label="Address"
            aria-invalid={refused || undefined}
            spellCheck={false}
            autoComplete="off"
            className={`h-7 min-w-0 flex-1 rounded-md bg-surface-sunken px-2.5 text-meta text-fg-primary outline-none transition-[box-shadow] placeholder:text-fg-tertiary focus:ring-2 focus:ring-focus-ring disabled:opacity-60 max-md:h-9 max-md:text-[14px] ${
              refused ? "ring-2 ring-error/60" : ""
            }`}
          />
        </form>
        <IconButton icon={X} label="Close preview" onClick={onClose} className="max-md:size-10" />
      </header>
      {/* A hairline that runs while the page loads. */}
      <div className="relative h-px shrink-0 overflow-hidden">
        {state?.loading ? (
          <div className="absolute inset-y-0 w-1/3 animate-[preview-load_1.1s_ease-in-out_infinite] bg-accent motion-reduce:animate-none" />
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {bridge === undefined ? (
          <Away>The preview opens in Cerium's desktop app.</Away>
        ) : (
          <Page
            bridge={bridge}
            threadId={threadId}
            url={url}
            error={state?.loading ? undefined : state?.error}
            onRetry={() => bridge.go(threadId, "reload")}
          />
        )}
      </div>
    </section>
  );
}

/** Where the shell lays the page, and what shows before there is one or when it failed to load. */
function Page({
  bridge,
  threadId,
  url,
  error,
  onRetry,
}: {
  bridge: PreviewBridge;
  threadId: string;
  url: string;
  error: string | undefined;
  onRetry: () => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const empty = url === "";
  const still = useLaidOver(bridge, threadId, area, empty || error !== undefined);
  return (
    <div className="absolute inset-0" style={{ padding: INSET }}>
      <div ref={area} className="relative h-full w-full overflow-hidden rounded-lg">
        {empty ? (
          <Away icon>Type an address above, or click a localhost link in a terminal.</Away>
        ) : error !== undefined ? (
          <Away icon>
            <span className="block text-fg-secondary">The page didn't load.</span>
            <span className="mt-1 block max-w-md break-words text-fg-tertiary">{error}</span>
            <Button
              onClick={onRetry}
              className="mt-3 h-7 rounded-md px-3 text-meta text-fg-primary ring-1 ring-line-subtle transition-colors hover:bg-surface-hover"
            >
              Try again
            </Button>
          </Away>
        ) : still ? (
          // What the page showed, while something the window draws covers it.
          <img src={still} alt="" className="h-full w-full object-cover object-left-top" />
        ) : (
          <div className="h-full w-full bg-white" />
        )}
      </div>
    </div>
  );
}

function Away({ children, icon = false }: { children: ReactNode; icon?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-meta text-fg-tertiary">
      {icon ? (
        <Globe size={22} strokeWidth={1.5} className="mb-3 text-fg-disabled" aria-hidden="true" />
      ) : null}
      <div>{children}</div>
    </div>
  );
}
