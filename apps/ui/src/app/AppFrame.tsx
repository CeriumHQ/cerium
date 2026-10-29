import type { ProviderId } from "@cerium/protocol";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { onMac } from "../backend/shell.ts";
import { CeriumBrand } from "../components/CeriumBrand.tsx";
import { ViewStack } from "../components/ViewStack.tsx";
import { usePresence, useRetained } from "../lib/motion.ts";
import { useKeyboardOpen } from "../web/viewport.ts";
import { useBackNavigation } from "./backNavigation.ts";
import { CompactBar } from "./CompactBar.tsx";
import { useCompact } from "./compact.ts";
import type { AppMode } from "./mode.ts";
import { GUTTER, panelLayout, RAIL, SIDE_PANELS, SIDEBAR, type SidePanelId } from "./panelLayout.ts";
import { ResizeHandle, usePanelWidth, usePanelWidths } from "./ResizeHandle.tsx";
import { SidePanelContext } from "./sidePanel.ts";
import { CompactPanelMenu, Titlebar, type PreviewToggleProps, type RunProps } from "./Titlebar.tsx";

interface AppFrameProps {
  readonly thread?: { readonly title: string; readonly project?: string };
  readonly mode: AppMode;
  /**
   * A thread's own window (threadWindow.ts): its thread alone, with its panels and terminal, and no
   * rail, sidebar, tabs or machine picker.
   */
  readonly alone?: boolean;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly onNewThread: () => void;
  /** The places, down the window's left edge (app/Rail.tsx); a phone's thread list shows them along its foot. */
  readonly rail: (orientation: "vertical" | "horizontal") => ReactNode;
  readonly sidebar: ReactNode;
  /** Providers of the selected thread's agents, lead first. */
  readonly agents: ReadonlyArray<ProviderId>;
  /**
   * The panel beside the transcript while one shows: which it is, and what it shows. The agents, the
   * files, the artifacts and Source control take that place one at a time.
   */
  readonly side: { readonly panel: SidePanelId; readonly content: ReactNode } | undefined;
  /**
   * The panels the window offers now, each by whether it's open (one can be open while settings
   * cover it); one left out has no button.
   */
  readonly panels: Partial<Record<SidePanelId, boolean>>;
  /** Opens a panel in that place, or closes it when it's the one open. */
  readonly onTogglePanel: (panel: SidePanelId) => void;
  /** Closes the panel that shows. */
  readonly onCloseSide: () => void;
  /**
   * The open thread's terminal drawer, offered while it can have one. The drawer itself is part of
   * `children`; in the narrow window it covers the thread, and the phone's Back hides it.
   */
  readonly terminal?: { readonly open: boolean; readonly onToggle: () => void };
  /** The open thread's project run button: starts its run command, and stops it while it runs; its menu has the project's actions. */
  readonly run?: RunProps;
  /** The open thread's browser, in the Preview pane beside it; the wide window's titlebar has its button. */
  readonly preview?: PreviewToggleProps;
  /**
   * Settings take the sidebar's place with their categories and the main panel's with the open
   * category. The thread views stay mounted underneath, so leaving settings returns to them as they were.
   */
  readonly settings: {
    readonly open: boolean;
    readonly nav: ReactNode;
    readonly page: ReactNode;
    /** The narrow window shows the categories, or one category's page, called `title`. */
    readonly pane: "nav" | "page";
    readonly title: string;
    /** From a category's page back to the categories. */
    readonly onBackToNav: () => void;
    readonly onClose: () => void;
  };
  /**
   * One of the rail's places besides the threads (GitHub, Tasks): its list takes the sidebar's place
   * and what's picked in it the main panel's. The thread views stay mounted underneath, and settings
   * cover it.
   */
  readonly page?: {
    readonly title: string;
    /** None on a wide window for a page that lays out its own list: the sidebar folds away. */
    readonly list?: ReactNode;
    readonly main: ReactNode;
    /** The narrow window shows the list, or what was picked in it. */
    readonly pane: "list" | "main";
    readonly onBackToList: () => void;
  };
  /** The narrow window shows one pane at a time: the threads, or the open (or new) thread. */
  readonly pane: "list" | "main";
  /** From the open thread back to the threads. */
  readonly onBack: () => void;
  /** Which of the account's computers the window drives, once there's a choice. */
  readonly machinePicker?: ReactNode;
  /** The open threads' tabs, in the titlebar of the wide window. */
  readonly tabs?: ReactNode;
  /** Closes the dialog open over the window, while one is: a phone's Back closes it first. */
  readonly closeDialog?: () => void;
  readonly children: ReactNode;
}

/**
 * The window: a titlebar over the thread sidebar, which sits directly on the window's glass, and the
 * transcript, which floats above it as an inset card. The sidebar folds away on demand (settings always
 * show theirs); the inspector opens beside the transcript on demand.
 */
export function AppFrame(props: AppFrameProps) {
  const compact = useCompact();
  const { thread, settings, page } = props;
  // The tab's and the taskbar's name for the window says where the user is.
  const title = settings.open ? "Settings" : page ? page.title : thread?.title;
  useEffect(() => {
    document.title = title ? `${title} · Cerium` : "Cerium";
  }, [title]);
  return compact ? <CompactFrame {...props} /> : <DesktopFrame {...props} />;
}

/** The width of an element, following it as the window resizes. */
function useWidthOf(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A side panel's content, which fades in when another panel takes the place. */
function SideContent({ panel, children }: { panel: SidePanelId | undefined; children: ReactNode }) {
  return (
    <div key={panel} className="h-full transition-opacity duration-200 ease-out-soft starting:opacity-0">
      {children}
    </div>
  );
}

function DesktopFrame({
  thread,
  mode,
  alone = false,
  sidebarOpen,
  onToggleSidebar,
  onNewThread,
  rail,
  sidebar,
  agents,
  side,
  panels,
  onTogglePanel,
  onCloseSide,
  terminal,
  run,
  preview,
  settings,
  page,
  machinePicker,
  tabs,
  children,
}: AppFrameProps) {
  const view = settings.open ? "settings" : page ? "page" : "threads";
  const covered = view !== "threads";
  const bare = alone || (view === "page" && page?.list === undefined);
  const wantSidebar = !bare && (sidebarOpen || covered);
  const showInspector = side !== undefined && !covered;
  // A closing panel keeps what it showed while it slides away.
  const inspector = useRef<HTMLDivElement>(null);
  const inspectorPhase = usePresence(showInspector, inspector);
  const shownSide = useRetained(side, showInspector);
  const sideSpec = SIDE_PANELS[shownSide?.panel ?? "agents"];

  const body = useRef<HTMLDivElement>(null);
  const floatingInspector = useRef<HTMLElement>(null);
  const bodyWidth = useWidthOf(body);
  const [savedSidebar, setSavedSidebar, rememberSidebar] = usePanelWidth(SIDEBAR.key, SIDEBAR.fallback);
  /** The panel beside the transcript's own width, as the user left it. */
  const [savedSide, setSavedSide, rememberSide] = usePanelWidths(SIDE_PANELS, shownSide?.panel ?? "agents");
  /** Which panel is being dragged, if any: it follows the pointer rather than easing toward it. */
  const [dragging, setDragging] = useState<"sidebar" | "inspector">();

  const sidebarMin = onMac() ? SIDEBAR.macMin : SIDEBAR.min;
  const saved = { sidebar: savedSidebar, inspector: savedSide };
  const withSidebar = panelLayout(bodyWidth, saved, wantSidebar, sideSpec, sidebarMin);
  // A window too narrow for the transcript, the sidebar and a panel together gives the sidebar up while
  // the panel is there (until it has slid out), rather than let the panel cover the transcript and its
  // message box. The panel's own button brings the sidebar back by closing the panel.
  const sidebarYields = withSidebar.foldsSidebar && inspectorPhase !== "gone";
  const showSidebar = wantSidebar && !sidebarYields;
  const { sidebarWidth, sidebarMax, sidebarSpace, floating, inspectorWidth, inspectorMax } = sidebarYields
    ? panelLayout(bodyWidth, saved, false, sideSpec, sidebarMin)
    : withSidebar;

  const inspectorHandle = (
    <ResizeHandle
      label={sideSpec.resizeLabel}
      edge="start"
      width={inspectorWidth}
      min={sideSpec.min}
      max={inspectorMax}
      fallback={sideSpec.fallback}
      onResize={setSavedSide}
      onCommit={rememberSide}
      onDragChange={(active) => setDragging(active ? "inspector" : undefined)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar
        {...(thread ? { thread } : {})}
        {...(settings.open ? { page: "Settings" } : page ? { page: page.title } : {})}
        bare={bare}
        alone={alone}
        mode={mode}
        sidebarOpen={sidebarOpen && !sidebarYields}
        sidebarWidth={sidebarWidth}
        resizing={dragging === "sidebar"}
        onToggleSidebar={sidebarYields ? onCloseSide : onToggleSidebar}
        onNewThread={onNewThread}
        agents={agents}
        panels={panels}
        onTogglePanel={onTogglePanel}
        {...(terminal ? { terminal } : {})}
        {...(run ? { run } : {})}
        {...(preview ? { preview } : {})}
        {...(alone ? {} : { machinePicker, tabs })}
      />
      <div className="flex min-h-0 flex-1">
        {/* A sunken strip of its own, so the places read apart from the sidebar's list on the same glass. */}
        {alone ? null : (
          <div style={{ width: RAIL }} className="shrink-0 pb-1.5 pl-1.5">
            <div className="h-full rounded-xl border border-line-subtle bg-surface-sunken">
              {rail("vertical")}
            </div>
          </div>
        )}
        <div ref={body} className={`relative flex min-w-0 flex-1 pr-1.5 pb-1.5 ${alone ? "pl-1.5" : ""}`}>
          {/* The sidebar keeps its width while the frame around it folds, so its rows don't reflow. */}
          <aside
            inert={!showSidebar}
            style={{ width: sidebarSpace }}
            className={`shrink-0 overflow-hidden ${
              dragging === "sidebar" ? "" : "transition-[width,opacity] duration-200 ease-out-soft"
            } ${showSidebar ? "opacity-100" : "opacity-0"}`}
          >
            <div className="h-full" style={{ width: sidebarWidth - GUTTER }}>
              {/* A thread's own window lists no threads, nor takes the list's keys. */}
              {alone ? null : (
                <ViewStack
                  active={view}
                  views={[
                    ["threads", sidebar],
                    ["page", page?.list],
                    ["settings", settings.nav],
                  ]}
                />
              )}
            </div>
          </aside>
          {showSidebar ? (
            <div className="relative w-0 shrink-0">
              <ResizeHandle
                label="Resize sidebar"
                edge="end"
                width={sidebarWidth}
                min={sidebarMin}
                max={sidebarMax}
                fallback={SIDEBAR.fallback}
                onResize={setSavedSidebar}
                onCommit={rememberSidebar}
                onDragChange={(active) => setDragging(active ? "sidebar" : undefined)}
              />
            </div>
          ) : null}
          <main
            // A floating inspector covers part of the transcript and the message box, so it gives way as
            // soon as the user reaches for either: clicking it, or an action in the inspector moving
            // focus there (Message). Focus coming back from a menu or another window leaves it open.
            {...(showInspector && floating
              ? {
                  onPointerDownCapture: onCloseSide,
                  onFocusCapture: (event: FocusEvent) => {
                    const from = event.relatedTarget;
                    if (from instanceof Node && floatingInspector.current?.contains(from)) onCloseSide();
                  },
                }
              : {})}
            // The thread views draw their own cards, one per pane of a split.
            className="min-w-0 flex-1"
          >
            <ViewStack
              active={view}
              views={[
                ["threads", children],
                ["page", page?.main],
                [
                  "settings",
                  <div
                    key="settings"
                    className="h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised"
                  >
                    {settings.page}
                  </div>,
                ],
              ]}
            />
          </main>
          {inspectorPhase !== "gone" ? (
            floating ? (
              <>
                {/* On the gutter left of the floating panel. */}
                {showInspector ? (
                  <div
                    className="absolute top-0 bottom-1.5 z-30 w-0"
                    style={{ right: inspectorWidth + GUTTER * 2 }}
                  >
                    {inspectorHandle}
                  </div>
                ) : null}
                {/* Slides in from the window's edge over the transcript, and back out. The panel
                    fades itself: fading what holds it would drop its blur until the fade ends. */}
                <div
                  ref={inspector}
                  data-phase={inspectorPhase}
                  // A thread's browser, docked under it, steps aside (features/preview).
                  data-floats=""
                  inert={!showInspector}
                  style={{ width: inspectorWidth }}
                  className="group/side absolute top-0 right-1.5 bottom-1.5 z-20 transition-[translate] duration-300 ease-out-soft data-[phase=entering]:starting:translate-x-6 data-[phase=leaving]:translate-x-6 data-[phase=leaving]:duration-200 data-[phase=leaving]:ease-in-soft"
                >
                  <aside
                    ref={floatingInspector}
                    className="h-full overflow-hidden rounded-xl border border-line-strong bg-surface-overlay shadow-overlay backdrop-blur-2xl transition-opacity duration-300 ease-out-soft group-data-[phase=entering]/side:starting:opacity-0 group-data-[phase=leaving]/side:opacity-0 group-data-[phase=leaving]/side:duration-200 group-data-[phase=leaving]/side:ease-in-soft"
                  >
                    <SidePanelContext value={{ floating: true, close: onCloseSide }}>
                      <SideContent panel={shownSide?.panel}>{shownSide?.content}</SideContent>
                    </SidePanelContext>
                  </aside>
                </div>
              </>
            ) : (
              <>
                {showInspector ? <div className="relative w-0 shrink-0">{inspectorHandle}</div> : null}
                {/* Slides out from under the window's edge as the transcript gives way, and back
                    under it; the panel keeps its width meanwhile, so its rows don't reflow. */}
                <div
                  ref={inspector}
                  data-phase={inspectorPhase}
                  inert={!showInspector}
                  style={{ "--side": `${inspectorWidth + GUTTER}px` } as CSSProperties}
                  className={`flex w-(--side) shrink-0 overflow-clip pl-1.5 data-[phase=shown]:overflow-visible data-[phase=entering]:starting:w-0 data-[phase=entering]:starting:opacity-0 data-[phase=leaving]:w-0 data-[phase=leaving]:opacity-0 ${
                    dragging === "inspector"
                      ? ""
                      : "transition-[width,opacity] duration-300 ease-out-soft data-[phase=leaving]:duration-200 data-[phase=leaving]:ease-in-soft"
                  }`}
                >
                  <aside
                    style={{ width: inspectorWidth }}
                    className="shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised"
                  >
                    <SidePanelContext value={{ floating: false, close: onCloseSide }}>
                      <SideContent panel={shownSide?.panel}>{shownSide?.content}</SideContent>
                    </SidePanelContext>
                  </aside>
                </div>
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * What keeps a pane's content off the notch or the rounded corners of a phone turned sideways. The top
 * bar keeps its own (CompactBar), so the panes under it step in by margin: the message box and what
 * else sits absolutely in them follow their edges.
 */
const notchSides = "ml-[env(safe-area-inset-left)] mr-[env(safe-area-inset-right)]";

/**
 * The phone-narrow window: one pane at a time, each under its own top
 * bar with the way back, and a thread's agents over the thread. Every pane stays mounted, so going
 * back finds it as it was left.
 */
function CompactFrame({
  thread,
  mode,
  rail,
  sidebar,
  agents,
  side,
  panels,
  onTogglePanel,
  onCloseSide,
  terminal,
  preview,
  settings,
  page,
  machinePicker,
  closeDialog,
  pane,
  onBack,
  children,
}: AppFrameProps) {
  const listLabel = mode === "work" ? "Inbox" : "Chats";
  const keyboardOpen = useKeyboardOpen();
  const view = settings.open
    ? settings.pane === "nav"
      ? "settings"
      : "category"
    : page
      ? page.pane === "list"
        ? "pageList"
        : "pageMain"
      : pane;
  const threadShown = !settings.open && page === undefined && pane === "main";
  const inspecting = side !== undefined && threadShown;
  // The terminal is a pane over the thread, and the agents or files a pane over that.
  const terminalOpen = terminal?.open === true && threadShown;
  const inspectDepth = 2 + (terminalOpen ? 1 : 0);
  // How many panes down the window is, a dialog over it counting as one more: the phone's own Back
  // button takes it up one.
  useBackNavigation(
    (settings.open
      ? settings.pane === "nav"
        ? 1
        : 2
      : page
        ? page.pane === "main"
          ? 1
          : 0
        : pane === "main"
          ? inspecting
            ? inspectDepth
            : terminalOpen
              ? 2
              : 1
          : 0) + (closeDialog ? 1 : 0),
    () => {
      if (closeDialog) closeDialog();
      else if (settings.open) {
        if (settings.pane === "page") settings.onBackToNav();
        else settings.onClose();
      } else if (page) page.onBackToList();
      else if (inspecting) onCloseSide();
      else if (terminalOpen) terminal.onToggle();
      else onBack();
    },
  );
  return (
    <div className="relative flex h-full flex-col bg-surface-window">
      <ViewStack
        active={view}
        views={[
          [
            "list",
            <div key="list" className="flex h-full flex-col">
              <CompactBar
                leading={
                  <div className="pl-3">
                    <CeriumBrand />
                  </div>
                }
                trailing={machinePicker}
              />
              <div className={`${notchSides} min-h-0 flex-1`}>{sidebar}</div>
              <div className={`${notchSides} pb-[max(env(safe-area-inset-bottom),6px)]`}>
                {rail("horizontal")}
              </div>
            </div>,
          ],
          [
            "main",
            <div key="main" className="flex h-full flex-col">
              <CompactBar
                back={{ label: listLabel, onBack }}
                folded={keyboardOpen}
                title={thread?.title ?? (mode === "work" ? "New thread" : "New chat")}
                {...(thread?.project ? { subtitle: thread.project } : {})}
                {...(Object.keys(panels).length > 0 || terminal
                  ? {
                      trailing: (
                        <CompactPanelMenu
                          agents={agents}
                          panels={panels}
                          onTogglePanel={onTogglePanel}
                          terminal={terminal}
                          preview={preview}
                        />
                      ),
                    }
                  : {})}
              />
              <main className={`${notchSides} relative min-h-0 flex-1 overflow-hidden`}>{children}</main>
            </div>,
          ],
          [
            "pageList",
            <div key="pageList" className="flex h-full flex-col">
              <CompactBar
                leading={
                  <div className="pl-3">
                    <CeriumBrand />
                  </div>
                }
                trailing={machinePicker}
              />
              <div className={`${notchSides} min-h-0 flex-1`}>{page?.list}</div>
              <div className={`${notchSides} pb-[max(env(safe-area-inset-bottom),6px)]`}>
                {rail("horizontal")}
              </div>
            </div>,
          ],
          [
            "pageMain",
            <div key="pageMain" className="flex h-full flex-col">
              <CompactBar back={{ label: page?.title ?? "", onBack: () => page?.onBackToList() }} />
              <div className={`${notchSides} relative min-h-0 flex-1 overflow-hidden`}>{page?.main}</div>
            </div>,
          ],
          [
            "settings",
            <div key="settings" className="flex h-full flex-col">
              <CompactBar back={{ label: listLabel, onBack: settings.onClose }} title="Settings" />
              <div className={`${notchSides} min-h-0 flex-1`}>{settings.nav}</div>
            </div>,
          ],
          [
            "category",
            <div key="category" className="flex h-full flex-col">
              <CompactBar back={{ label: "Settings", onBack: settings.onBackToNav }} title={settings.title} />
              <div className={`${notchSides} min-h-0 flex-1`}>{settings.page}</div>
            </div>,
          ],
        ]}
      />
      {inspecting ? (
        <div
          data-floats=""
          className={`${notchSides} absolute inset-0 z-30 flex flex-col bg-surface-panel pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl`}
        >
          {side?.content}
        </div>
      ) : null}
    </div>
  );
}
