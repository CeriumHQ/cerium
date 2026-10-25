import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import type { ProviderId } from "@cerium/protocol";
import {
  ArrowRightToLine,
  CircleDot,
  Columns2,
  GitPullRequestArrow,
  History,
  PenLine,
  Pin,
  Plus,
  Rows2,
  X,
  XSquare,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { settled, useArrivals, useLingering } from "../../lib/motion.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
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
}

const tabKey = (tab: TabView) => tab.key;

/** How far the pointer travels before pressing a tab becomes dragging it. */
const DRAG_THRESHOLD = 4;
/** How far below the strip a dragged tab goes before it's carried to the panes instead. */
const SPLIT_THRESHOLD = 24;

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
}: {
  tabs: ReadonlyArray<TabView>;
  active: string | undefined;
  /** What the new-tab button starts: a thread or a chat. */
  newLabel: string;
} & TabActions) {
  const list = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  /**
   * The tab pressed, and the one shown before it: a tab carried off the strip to the panes gives the
   * focused pane back what it showed.
   */
  const press = useRef<{
    key: string;
    x: number;
    dragging: boolean;
    before: string | undefined;
    carried: boolean;
  }>(undefined);
  const [dragging, setDragging] = useState<string>();
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

  // The active tab scrolls into view when the strip holds more than fits.
  useEffect(() => {
    if (active === undefined) return;
    nodes.current.get(active)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active, tabs.length]);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [tabs.length]);

  const onPointerDown = (event: PointerEvent<HTMLElement>, key: string) => {
    // The middle button closes on release; pressed, it would start the browser's autoscroll.
    if (event.button === 1) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-tab-close]")) return;
    press.current = { key, x: event.clientX, dragging: false, before: active, carried: false };
    // The tab follows the pointer from the press, so one pulled straight down off the strip is still its own.
    event.currentTarget.setPointerCapture(event.pointerId);
    if (key !== active) onActivate(key);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (current === undefined) return;
    if (current.carried) {
      paneDrag.move(event.clientX, event.clientY);
      return;
    }
    const bottom = list.current?.getBoundingClientRect().bottom ?? Infinity;
    // Pulled down off the strip, the tab goes to the panes, to open beside one of them.
    if (onSplit && event.clientY > bottom + SPLIT_THRESHOLD) {
      current.carried = true;
      if (!current.dragging) event.currentTarget.setPointerCapture(event.pointerId);
      current.dragging = true;
      setDragging(current.key);
      if (current.before !== undefined && current.before !== current.key) onActivate(current.before);
      paneDrag.begin({ kind: "thread", key: current.key }, event.clientX, event.clientY);
      return;
    }
    if (!current.dragging) {
      if (Math.abs(event.clientX - current.x) < DRAG_THRESHOLD) return;
      current.dragging = true;
      setDragging(current.key);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // The dragged tab takes the place of every tab whose middle the pointer has passed.
    const others = tabs.filter((tab) => tab.key !== current.key);
    const index = others.filter((tab) => {
      const rect = nodes.current.get(tab.key)?.getBoundingClientRect();
      return rect !== undefined && rect.left + rect.width / 2 < event.clientX;
    }).length;
    if (index !== tabs.findIndex((tab) => tab.key === current.key)) onMove(current.key, index);
  };
  const endPress = (event: PointerEvent<HTMLElement>) => {
    if (press.current?.carried) {
      if (event.type === "pointerup") paneDrag.drop(event.clientX, event.clientY);
      else paneDrag.cancel();
    }
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
          onScroll={measure}
          style={{
            maskImage: `linear-gradient(to right, ${hidden.start ? "transparent, black 2rem" : "black"}, ${
              hidden.end ? "black calc(100% - 2rem), transparent" : "black"
            })`,
          }}
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
                node={(element) => {
                  if (element) nodes.current.set(tab.key, element);
                  else nodes.current.delete(tab.key);
                }}
                others={tabs.length > 1}
                hasRight={tabs.at(-1)?.key !== tab.key}
                onPointerDown={(event) => onPointerDown(event, tab.key)}
                onPointerMove={onPointerMove}
                onPointerEnd={endPress}
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
              />
            ) : (
              <ClosingTab key={key} tab={tab} onGone={() => release(key)} />
            ),
          )}
          {/* Placed again as a closed tab goes, which can move the active one without resizing it. */}
          <Tabs.Indicator
            data-tabs={shown.length}
            className="absolute top-1/2 left-0 -z-10 h-7 w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-1/2 rounded-lg border border-line-subtle bg-surface-selected shadow-raised transition-[translate,width] duration-200 ease-out-soft motion-reduce:transition-none"
          />
        </Tabs.List>
      </Tabs.Root>
      <Tooltip label={newLabel} shortcut="Ctrl T">
        <Button
          aria-label={newLabel}
          onClick={onNewTab}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 [app-region:no-drag] hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active"
        >
          <Plus size={15} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A tab just closed, shrinking away so the tabs after it close the gap. */
function ClosingTab({ tab, onGone }: { tab: TabView; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useAtomValue(newThreadDraftTitleAtom(tab.key)) ?? tab.title;
  const gone = useEffectEvent(onGone);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Its face keeps the width the tab had, and is cut off rather than squeezed as the tab narrows.
    element.style.setProperty("--closing-width", `${element.offsetWidth}px`);
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
      className="flex h-7 max-w-0 min-w-0 basis-0 items-center overflow-hidden opacity-0 transition-[flex-basis,min-width,max-width,opacity] duration-[220ms,220ms,220ms,120ms] ease-out-soft starting:max-w-52 starting:min-w-28 starting:basis-52 starting:opacity-100"
    >
      <span className="flex h-full w-(--closing-width) shrink-0 items-center gap-2 pr-7 pl-2.5 text-[12.5px] text-fg-tertiary">
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
            <PenLine size={8} strokeWidth={2.25} />
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
  node,
  others,
  hasRight,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onClose,
  onCloseOthers,
  onCloseRight,
  onKeep,
  onReopen,
  onSplit,
}: {
  tab: TabView;
  active: boolean;
  /** It was opened while the strip was in view, rather than there when the window opened. */
  arriving: boolean;
  dragging: boolean;
  node: (element: HTMLElement | null) => void;
  /** Other tabs are open, which "Close others" would close. */
  others: boolean;
  hasRight: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>) => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onKeep: () => void;
  onReopen?: () => void;
  onSplit?: (side: "right" | "bottom") => void;
}) {
  const unread = tab.unread === true && !active;
  const title = useAtomValue(newThreadDraftTitleAtom(tab.key)) ?? tab.title;
  return (
    <ContextMenuArea
      menu={
        <>
          {tab.preview ? (
            <MenuItem icon={Pin} onClick={onKeep}>
              Keep open
            </MenuItem>
          ) : null}
          {onSplit ? (
            <>
              <MenuItem icon={Columns2} onClick={() => onSplit("right")}>
                Open to the right
              </MenuItem>
              <MenuItem icon={Rows2} onClick={() => onSplit("bottom")}>
                Open below
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem icon={X} shortcut="Ctrl W" onClick={onClose}>
            Close
          </MenuItem>
          <MenuItem icon={XSquare} disabled={!others} onClick={onCloseOthers}>
            Close others
          </MenuItem>
          <MenuItem icon={ArrowRightToLine} disabled={!hasRight} onClick={onCloseRight}>
            Close to the right
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={History}
            shortcut="Ctrl Shift T"
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
        onDoubleClick={tab.preview ? onKeep : undefined}
        className={`group/tab relative flex h-7 max-w-52 min-w-28 basis-52 items-center rounded-lg transition-[background-color,opacity,flex-basis,min-width,max-width] ${
          // A tab opened grows out of the strip from nothing, pushing those after it along.
          arriving
            ? "overflow-hidden duration-[150ms,200ms,240ms,240ms,240ms] ease-out-soft starting:max-w-0 starting:min-w-0 starting:basis-0 starting:opacity-0"
            : "duration-150"
        } ${dragging ? "z-10 cursor-grabbing" : ""} ${active ? "" : "hover:bg-surface-hover"}`}
      >
        <Tabs.Tab
          value={tab.key}
          // The full title, and where it is, for a tab too narrow to say.
          title={tab.project ? `${title}\n${tab.project}` : title}
          className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-7 pl-2.5 text-left text-[12.5px] outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset ${
            active
              ? "text-fg-primary"
              : tab.beside
                ? "text-fg-secondary group-hover/tab:text-fg-primary"
                : "text-fg-tertiary group-hover/tab:text-fg-secondary"
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
