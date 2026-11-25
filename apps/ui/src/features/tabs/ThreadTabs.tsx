import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import type { ProviderId } from "@cerium/protocol";
import {
  AppWindow,
  ArrowRightToLine,
  CircleDot,
  Columns2,
  GitPullRequestArrow,
  History,
  MessagesSquare,
  PenLine,
  Pin,
  Plus,
  Rows2,
  X,
  XSquare,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { settled, useArrivals, useGlide, useLingering, usePresence } from "../../lib/motion.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { CopyLinkMenuItem } from "../launch/CopyLink.tsx";
import { ExportMenuItems } from "../export/ExportItems.tsx";
import { isNonThreadKey } from "./tabKinds.ts";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useShortcut } from "../../lib/shortcuts.ts";
import { newThreadDraftTitleAtom } from "../composer/drafts.ts";
import type { ThreadSummary } from "../threads/model.ts";
import { paneDrag } from "../split/drag.ts";
import { ThreadMark } from "../threads/StatusIndicator.tsx";
import type { GitHubTab } from "../github/model.ts";
import type { FileTab } from "../viewer/model.ts";

/** What a tab shows of the thread, or the thread not started yet, it holds. */
export interface TabView {
  readonly key: string;
  /** A thread not started yet's is "New thread": its tab reads the draft's own title as it changes. */
  readonly title: string;
  /** A thread not started yet: there's nothing running, only a draft. */
  readonly draft: boolean;
  /** Whether this tab holds a chat thread or new-chat draft (vs. a work thread). */
  readonly chat?: boolean;
  /** The preview tab, which the next thread opened from the sidebar replaces. */
  readonly preview: boolean;
  readonly status?: ThreadSummary["status"];
  readonly unread?: boolean;
  /** Its lead's harness. */
  readonly provider?: ProviderId;
  readonly project?: string;
  /** The thread it holds, once the list has brought it: what its mark is drawn from. */
  readonly thread?: ThreadSummary;
  /** It shows in a pane beside the focused one. */
  readonly beside?: boolean;
  /** A work thread's file the viewer shows, rather than a thread. */
  readonly file?: FileTab;
  /** A pull request or an issue, rather than a thread. */
  readonly github?: GitHubTab;
}

export interface TabActions {
  readonly onActivate: (key: string) => void;
  readonly onClose: (keys: ReadonlyArray<string>) => void;
  readonly onKeep: (key: string) => void;
  readonly onMove: (key: string, index: number) => void;
  readonly onNewTab: () => void;
  /** Reopens the tab closed last; absent while there is none. */
  readonly onReopen?: () => void;
  /** Opens the tab's thread in a pane on `side` of the focused one; absent where panes can't split. */
  readonly onSplit?: (key: string, side: "right" | "bottom") => void;
  /** Opens the tab's thread in a window of its own; absent where there are no such windows. */
  readonly onOpenWindow?: (threadId: string) => void;
}

const tabKey = (tab: TabView) => tab.key;

/** How far the pointer travels before pressing a tab becomes dragging it. */
const DRAG_THRESHOLD = 4;
/** How far below the strip a dragged tab goes before it's carried to the panes instead. */
const SPLIT_THRESHOLD = 24;
const TAB_MOTION_MS = 220;

/**
 * The open threads as tabs in the titlebar, beside the new-tab button. A tab is shown as the pointer
 * presses it, so it can be dragged straight away; the middle button closes it and a double click
 * keeps a preview.
 */
export function ThreadTabs({
  tabs,
  active,
  newLabel,
  onActivate,
  onClose,
  onKeep,
  onMove,
  onNewTab,
  onReopen,
  onSplit,
  onOpenWindow,
}: {
  tabs: ReadonlyArray<TabView>;
  active: string | undefined;
  /** What the new-tab button starts: a thread or a chat. */
  newLabel: string;
} & TabActions) {
  const list = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const closingWidths = useRef(new Map<string, number>());
  const indicator = useRef<HTMLSpanElement>(null);
  const selection = useRef<{ key: string | undefined; animation?: Animation }>({ key: undefined });
  const newTabKeys = useShortcut("new-tab");
  /**
   * The tab pressed, and the one shown before it: a tab carried off the strip to the panes gives the
   * focused pane back what it showed.
   */
  const press = useRef<{
    key: string;
    x: number;
    grabbedAt: number;
    pointerX: number;
    dragging: boolean;
    before: string | undefined;
    carried: boolean;
  }>(undefined);
  const [dragging, setDragging] = useState<string>();
  const glide = useGlide({
    axis: "x",
    enabled: dragging !== undefined,
    skip: dragging,
    duration: TAB_MOTION_MS,
  });
  const bindTab = useCallback(
    (key: string, element: HTMLElement) => {
      nodes.current.set(key, element);
      const unbind = glide(key)(element);
      return () => {
        closingWidths.current.set(key, element.getBoundingClientRect().width);
        nodes.current.delete(key);
        unbind();
      };
    },
    [glide],
  );
  // Tabs opened and closed move; one taking another's place (a preview replaced, a draft started)
  // just changes.
  const [shown, release] = useLingering(tabs, tabKey, (before, after) => after.length < before.length);
  const arrived = useArrivals(
    tabs.map((tab) => tab.key),
    { replacements: false },
  );
  /** Which ends of the strip hide tabs past them, to fade so the hidden tabs show they're there. */
  const [hidden, setHidden] = useState({ start: false, end: false });
  const measure = () => {
    const element = list.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setHidden((was) => (was.start === start && was.end === end ? was : { start, end }));
  };

  // Follow live layout during a grow, collapse, or drag. Only a change of selection adds travel.
  const placeIndicator = () => {
    const strip = list.current;
    const marker = indicator.current;
    if (!strip || !marker) return;
    const tab = active === undefined ? undefined : nodes.current.get(active);
    const previous = selection.current;
    const changed = previous.key !== active;
    const held = press.current?.key === active && press.current?.dragging && !press.current.carried;
    marker.toggleAttribute("data-held", !!held);
    const from = changed && !marker.hidden ? marker.getBoundingClientRect() : undefined;
    if (changed || (held && previous.animation)) {
      previous.animation?.cancel();
      selection.current = { key: active };
    }
    const to = tab?.getBoundingClientRect();
    marker.hidden = !to || to.width <= 2;
    if (!tab || !to) return;
    const style = getComputedStyle(tab);
    marker.style.setProperty(
      "--tab-left",
      `${to.left - strip.getBoundingClientRect().left + strip.scrollLeft}px`,
    );
    marker.style.setProperty("--tab-width", `${to.width}px`);
    marker.style.opacity = style.opacity;
    if (
      from &&
      !tab.hasAttribute("data-arriving") &&
      !held &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const x = from.left - to.left;
      const width = from.width - to.width;
      if (x !== 0 || width !== 0) {
        // The offset eases away while the next tab's own slot can still move as a neighbor closes.
        selection.current.animation = marker.animate(
          [
            {
              translate: `calc(var(--tab-left) + ${x}px) -50%`,
              width: `calc(var(--tab-width) + ${width}px)`,
            },
            { translate: "var(--tab-left) -50%", width: "var(--tab-width)" },
          ],
          {
            duration: previous.key !== undefined && !nodes.current.has(previous.key) ? TAB_MOTION_MS : 200,
            easing: style.getPropertyValue("--ease-out-soft").trim(),
          },
        );
      }
    }
    return style.translate !== "none";
  };

  const placeDraggedTab = () => {
    const current = press.current;
    const strip = list.current;
    if (!current?.dragging || current.carried || !strip) return;
    const tab = nodes.current.get(current.key);
    if (!tab) return;
    const x = current.pointerX - strip.getBoundingClientRect().left + strip.scrollLeft;
    const end = indicator.current?.previousElementSibling;
    const edge = end instanceof HTMLElement ? end.offsetLeft + end.offsetWidth - tab.offsetWidth : 0;
    const left = Math.max(0, Math.min(edge, x - current.grabbedAt));
    tab.style.transform = `translateX(${left - tab.offsetLeft}px)`;
  };

  useLayoutEffect(() => {
    closingWidths.current.clear();
    placeDraggedTab();
    // A selected tab can still be gliding after a quick drop. A translation does not fire resize.
    let frame = 0;
    const follow = () => {
      if (placeIndicator()) frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  });
  const onResize = useEffectEvent(() => {
    measure();
    placeDraggedTab();
    placeIndicator();
  });

  // The active tab scrolls into view when the strip holds more than fits.
  useEffect(() => {
    const tab = active === undefined ? undefined : nodes.current.get(active);
    if (!tab || press.current?.dragging) return;
    const reveal = () =>
      tab.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    reveal();
    if (!tab.hasAttribute("data-arriving")) return;
    let live = true;
    // A tab that fit at its starting width can extend past the end once it has grown.
    void settled(tab).then(() => {
      if (live && !press.current?.dragging) reveal();
    });
    return () => {
      live = false;
    };
  }, [active, tabs.length]);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() => onResize());
    observer.observe(element);
    for (const child of element.children) {
      if (child !== indicator.current) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [shown]);

  const onPointerDown = (event: PointerEvent<HTMLElement>, key: string) => {
    // The middle button closes on release; pressed, it would start the browser's autoscroll.
    if (event.button === 1) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-tab-close]")) return;
    press.current = {
      key,
      x: event.clientX,
      pointerX: event.clientX,
      grabbedAt: event.clientX - event.currentTarget.getBoundingClientRect().left,
      dragging: false,
      before: active,
      carried: false,
    };
    // The tab follows the pointer from the press, so one pulled straight down off the strip is still its own.
    event.currentTarget.setPointerCapture(event.pointerId);
    if (key !== active) onActivate(key);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    const strip = list.current;
    if (!current || !strip) return;
    if (current.carried) {
      paneDrag.move(event.clientX, event.clientY);
      return;
    }
    const bounds = strip.getBoundingClientRect();
    // Pulled down off the strip, the tab goes to the panes, to open beside one of them.
    if (onSplit && event.clientY > bounds.bottom + SPLIT_THRESHOLD) {
      current.carried = true;
      if (!current.dragging) event.currentTarget.setPointerCapture(event.pointerId);
      current.dragging = true;
      setDragging(current.key);
      nodes.current.get(current.key)?.style.removeProperty("transform");
      if (current.before !== undefined && current.before !== current.key) onActivate(current.before);
      paneDrag.begin({ kind: "thread", key: current.key }, event.clientX, event.clientY);
      return;
    }
    if (!current.dragging) {
      if (Math.abs(event.clientX - current.x) < DRAG_THRESHOLD) return;
      current.dragging = true;
      setDragging(current.key);
      // The list keeps capture when React moves a tab's DOM node to its new slot.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    current.pointerX = event.clientX;
    placeDraggedTab();
    placeIndicator();
    // Compare the pointer to layout slots so ongoing glides cannot change reorder thresholds.
    const x = event.clientX - bounds.left + strip.scrollLeft;
    const others = tabs.filter((tab) => tab.key !== current.key);
    const index = others.filter((tab) => {
      const node = nodes.current.get(tab.key);
      return node !== undefined && node.offsetLeft + node.offsetWidth / 2 < x;
    }).length;
    if (index !== tabs.findIndex((tab) => tab.key === current.key)) onMove(current.key, index);
  };
  const endPress = (event: PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (!current) return;
    if (current.carried) {
      if (event.type === "pointerup") paneDrag.drop(event.clientX, event.clientY);
      else paneDrag.cancel();
    }
    nodes.current.get(current.key)?.style.removeProperty("transform");
    press.current = undefined;
    setDragging(undefined);
  };
  // A wheel scrolls the strip sideways: it has no other way to go.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (list.current && event.deltaX === 0) list.current.scrollLeft += event.deltaY;
  };

  return (
    <div className="flex h-full min-w-0 items-center gap-0.5">
      <Tabs.Root
        value={active ?? null}
        onValueChange={(value) => {
          // Keyboard choices land here; the pointer's are shown as it presses.
          if (typeof value === "string" && value !== active) onActivate(value);
        }}
        className="flex h-full min-w-0"
      >
        <Tabs.List
          ref={list}
          aria-label="Open threads"
          onWheel={onWheel}
          onScroll={() => {
            measure();
            placeDraggedTab();
            placeIndicator();
          }}
          onPointerMove={onPointerMove}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) endPress(event);
          }}
          style={
            {
              "--tab-motion": `${TAB_MOTION_MS}ms`,
              maskImage: `linear-gradient(to right, ${hidden.start ? "transparent, black 2rem" : "black"}, ${
                hidden.end ? "black calc(100% - 2rem), transparent" : "black"
              })`,
            } as CSSProperties
          }
          className="relative z-0 flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [app-region:no-drag]"
        >
          {shown.map(({ key, item: tab, present }) =>
            present ? (
              <ThreadTab
                key={key}
                tab={tab}
                active={tab.key === active}
                arriving={arrived(tab.key)}
                dragging={dragging === tab.key}
                bindTab={bindTab}
                others={tabs.length > 1}
                hasRight={tabs.at(-1)?.key !== tab.key}
                onPointerDown={(event) => onPointerDown(event, tab.key)}
                onClose={() => onClose([tab.key])}
                onCloseOthers={() =>
                  onClose(tabs.filter((each) => each.key !== tab.key).map((each) => each.key))
                }
                onCloseRight={() =>
                  onClose(
                    tabs.slice(tabs.findIndex((each) => each.key === tab.key) + 1).map((each) => each.key),
                  )
                }
                onKeep={() => onKeep(tab.key)}
                {...(onReopen ? { onReopen } : {})}
                // The focused pane's own tab has nowhere beside itself to go.
                {...(onSplit && tab.key !== active
                  ? { onSplit: (side: "right" | "bottom") => onSplit(tab.key, side) }
                  : {})}
                // A thread that has started, on this computer.
                {...(onOpenWindow && tab.thread && tab.thread.elsewhere === undefined
                  ? { onOpenWindow: () => onOpenWindow(tab.key) }
                  : {})}
              />
            ) : (
              <ClosingTab
                key={key}
                tab={tab}
                lastWidth={() => closingWidths.current.get(key) ?? 0}
                onGone={() => release(key)}
              />
            ),
          )}
          <span
            ref={indicator}
            data-tab-indicator
            aria-hidden
            hidden
            className="pointer-events-none absolute top-1/2 left-0 -z-10 h-7 w-(--tab-width) translate-x-(--tab-left) -translate-y-1/2 rounded-lg border border-line-subtle bg-surface-selected shadow-raised data-held:z-9 data-held:bg-backdrop data-held:[background-image:linear-gradient(var(--surface-selected),var(--surface-selected)),linear-gradient(var(--surface-window),var(--surface-window))]"
          />
        </Tabs.List>
      </Tabs.Root>
      <Tooltip label={newLabel} shortcut={newTabKeys}>
        <Button
          aria-label={newLabel}
          onClick={onNewTab}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 [app-region:no-drag] hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active pointer-coarse:size-10"
        >
          <Plus size={15} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A tab just closed, shrinking away so the tabs after it close the gap. */
function ClosingTab({
  tab,
  lastWidth,
  onGone,
}: {
  tab: TabView;
  lastWidth: () => number;
  onGone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useAtomValue(newThreadDraftTitleAtom(tab.key)) ?? tab.title;
  const width = useEffectEvent(lastWidth);
  const gone = useEffectEvent(onGone);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Its face keeps the width the tab had, and is cut off rather than squeezed as the tab narrows.
    element.style.setProperty("--closing-width", `${width()}px`);
    let live = true;
    void settled(element).then(() => {
      if (live) gone();
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      inert
      className="-mr-0.5 flex h-7 max-w-0 min-w-0 basis-0 items-center overflow-hidden opacity-0 transition-[flex-basis,min-width,max-width,margin-right,opacity] duration-[var(--tab-motion),var(--tab-motion),var(--tab-motion),var(--tab-motion),120ms] ease-out-soft starting:mr-0 starting:max-w-(--closing-width) starting:min-w-(--closing-width) starting:basis-(--closing-width) starting:opacity-100"
    >
      <span className="flex h-full w-(--closing-width) shrink-0 items-center gap-2 pr-7 pl-2.5 text-meta text-fg-tertiary">
        <TabFace tab={tab} title={title} active={false} unread={false} />
      </span>
    </div>
  );
}

/** A tab's mark and title. */
function TabFace({
  tab,
  title,
  active,
  unread,
}: {
  tab: TabView;
  title: string;
  active: boolean;
  unread: boolean;
}) {
  return (
    <>
      <span className="grid size-3.5 shrink-0 place-items-center">
        {tab.file ? (
          <FileIcon path={tab.file.path} className={`size-3.5 ${active ? "" : "opacity-80"}`} />
        ) : tab.github ? (
          tab.github.kind === "pr" ? (
            <GitPullRequestArrow size={13} strokeWidth={2} aria-hidden />
          ) : (
            <CircleDot size={13} strokeWidth={2} aria-hidden />
          )
        ) : tab.draft ? (
          <span
            aria-hidden
            className="grid size-3.5 place-items-center rounded-[4px] border border-dashed border-current opacity-70"
          >
            {tab.chat ? (
              <MessagesSquare size={8} strokeWidth={2.25} />
            ) : (
              <PenLine size={8} strokeWidth={2.25} />
            )}
          </span>
        ) : tab.thread ? (
          <span className={active || unread || tab.thread.status !== "idle" ? "" : "opacity-80"}>
            <ThreadMark thread={tab.thread} unread={unread} size="small" />
          </span>
        ) : tab.provider ? (
          <span className={active ? "" : "opacity-70 grayscale-[0.4]"}>
            <ProviderLogo provider={tab.provider} size={12} />
          </span>
        ) : null}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${tab.preview ? "italic" : ""} ${
          unread ? "font-medium text-fg-primary" : ""
        }`}
      >
        {title}
      </span>
    </>
  );
}

function ThreadTab({
  tab,
  active,
  arriving,
  dragging,
  bindTab,
  others,
  hasRight,
  onPointerDown,
  onClose,
  onCloseOthers,
  onCloseRight,
  onKeep,
  onReopen,
  onSplit,
  onOpenWindow,
}: {
  tab: TabView;
  active: boolean;
  /** It was opened while the strip was in view, rather than there when the window opened. */
  arriving: boolean;
  dragging: boolean;
  bindTab: (key: string, element: HTMLElement) => () => void;
  /** Other tabs are open, which "Close others" would close. */
  others: boolean;
  hasRight: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onKeep: () => void;
  onReopen?: () => void;
  onSplit?: (side: "right" | "bottom") => void;
  onOpenWindow?: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const node = useCallback(
    (tabElement: HTMLDivElement | null) => {
      element.current = tabElement;
      if (!tabElement) return;
      const unbind = bindTab(tab.key, tabElement);
      return () => {
        element.current = null;
        unbind();
      };
    },
    [bindTab, tab.key],
  );
  const entering = usePresence(true, element, { appear: arriving }) === "entering";
  const unread = tab.unread === true && !active;
  const title = useAtomValue(newThreadDraftTitleAtom(tab.key)) ?? tab.title;
  const closeTabKeys = useShortcut("close-tab");
  const reopenTabKeys = useShortcut("reopen-tab");
  return (
    <ContextMenuArea
      menu={
        <>
          {tab.preview ? (
            <MenuItem icon={Pin} onClick={onKeep}>
              Keep open
            </MenuItem>
          ) : null}
          {onSplit || onOpenWindow ? (
            <>
              {onSplit ? (
                <>
                  <MenuItem icon={Columns2} onClick={() => onSplit("right")}>
                    Open to the right
                  </MenuItem>
                  <MenuItem icon={Rows2} onClick={() => onSplit("bottom")}>
                    Open below
                  </MenuItem>
                </>
              ) : null}
              {onOpenWindow ? (
                <MenuItem icon={AppWindow} onClick={onOpenWindow}>
                  Open in new window
                </MenuItem>
              ) : null}
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem icon={X} shortcut={closeTabKeys} onClick={onClose}>
            Close
          </MenuItem>
          <MenuItem icon={XSquare} disabled={!others} onClick={onCloseOthers}>
            Close others
          </MenuItem>
          <MenuItem icon={ArrowRightToLine} disabled={!hasRight} onClick={onCloseRight}>
            Close to the right
          </MenuItem>
          <MenuSeparator />
          {tab.draft || isNonThreadKey(tab.key) ? null : (
            <>
              <CopyLinkMenuItem threadId={tab.key} />
              <ExportMenuItems threadId={tab.key} />
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={History}
            shortcut={reopenTabKeys}
            disabled={onReopen === undefined}
            {...(onReopen ? { onClick: onReopen } : {})}
          >
            Reopen closed tab
          </MenuItem>
        </>
      }
    >
      <div
        ref={node}
        data-arriving={entering ? "" : undefined}
        onPointerDown={onPointerDown}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
        onDoubleClick={tab.preview ? onKeep : undefined}
        className={`group/tab relative flex h-7 max-w-52 min-w-28 basis-52 items-center rounded-lg transition-[background-color,opacity,flex-basis,min-width,max-width] ${
          // A tab opened grows out of the strip from nothing, pushing those after it along.
          entering
            ? "overflow-hidden duration-[150ms,var(--tab-motion),var(--tab-motion),var(--tab-motion),var(--tab-motion)] ease-out-soft starting:max-w-0 starting:min-w-0 starting:basis-0 starting:opacity-0"
            : "duration-150"
        } ${dragging ? "z-10 cursor-grabbing" : ""} ${active ? "" : "hover:bg-surface-hover"}`}
      >
        <Tabs.Tab
          value={tab.key}
          // The full title, and where it is, for a tab too narrow to say.
          title={tab.project ? `${title}\n${tab.project}` : title}
          className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-7 pl-2.5 text-left text-meta outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset ${
            active
              ? "text-fg-primary"
              : tab.beside
                ? "text-fg-primary"
                : "text-fg-secondary group-hover/tab:text-fg-primary"
          }`}
        >
          <TabFace tab={tab} title={title} active={active} unread={unread} />
        </Tabs.Tab>
        <Button
          data-tab-close
          aria-label={`Close “${title}”`}
          tabIndex={-1}
          onClick={onClose}
          className={`absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-md text-fg-tertiary transition-[opacity,background-color,color] duration-150 hover:bg-surface-active hover:text-fg-primary ${
            active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
          }`}
        >
          <X size={12} strokeWidth={2} />
        </Button>
      </div>
    </ContextMenuArea>
  );
}
