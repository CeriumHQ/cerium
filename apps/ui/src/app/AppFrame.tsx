import type { ProviderId } from "@cerium/protocol";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { CeriumMark } from "../components/CeriumMark.tsx";
import { ViewStack } from "../components/ViewStack.tsx";
import { useKeyboardOpen } from "../web/viewport.ts";
import { useBackNavigation } from "./backNavigation.ts";
import { CompactBar } from "./CompactBar.tsx";
import { useCompact } from "./compact.ts";
import { ModeSwitch, type AppMode } from "./ModeSwitch.tsx";
import { FILES, GUTTER, INSPECTOR, panelLayout, SIDEBAR } from "./panelLayout.ts";
import { ResizeHandle, usePanelWidth } from "./ResizeHandle.tsx";
import { SidePanelContext } from "./sidePanel.ts";
import { AgentsToggle, FilesToggle, TerminalToggle, Titlebar } from "./Titlebar.tsx";

interface AppFrameProps {
  readonly thread?: { readonly title: string; readonly project?: string };
  readonly mode: AppMode;
  readonly onModeChange: (mode: AppMode) => void;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly onNewThread: () => void;
  readonly sidebar: ReactNode;
  /** Providers of the selected thread's agents, lead first. */
  readonly agents: ReadonlyArray<ProviderId>;
  /** The agent inspector, shown beside the transcript only while open. */
  readonly inspector: ReactNode | undefined;
  readonly onToggleInspector: () => void;
  /** Closes the inspector, whether or not it's open. */
  readonly onCloseInspector: () => void;
  /**
   * The files panel, in the inspector's place: one of the two shows at a time, so this is only
   * given while the inspector isn't. Absent when there is no folder to browse.
   */
  readonly files: ReactNode | undefined;
  /** There is a folder to browse, so the window offers the panel. */
  readonly filesAvailable: boolean;
  /** Whether the files panel is open (it can be open without `files`, when settings cover it). */
  readonly filesOpen: boolean;
  readonly onToggleFiles: () => void;
  readonly onCloseFiles: () => void;
  /**
   * The open thread's terminal drawer, offered while it can have one. The drawer itself is part of
   * `children`; in the narrow window it covers the thread, and the phone's Back hides it.
   */
  readonly terminal?: { readonly open: boolean; readonly onToggle: () => void };
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
  const { thread, settings } = props;
  // The tab's and the taskbar's name for the window says where the user is.
  const title = settings.open ? "Settings" : thread?.title;
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

function DesktopFrame({
  thread,
  mode,
  onModeChange,
  sidebarOpen,
  onToggleSidebar,
  onNewThread,
  sidebar,
  agents,
  inspector,
  onToggleInspector,
  onCloseInspector,
  files,
  filesAvailable,
  filesOpen,
  onToggleFiles,
  onCloseFiles,
  terminal,
  settings,
  machinePicker,
  tabs,
  children,
}: AppFrameProps) {
  const view = settings.open ? "settings" : "threads";
  const showSidebar = sidebarOpen || settings.open;
  // The agents and the files take the same place beside the transcript, one at a time.
  const side = inspector ?? files;
  const showInspector = side !== undefined && !settings.open;
  const sideSpec = files !== undefined ? FILES : INSPECTOR;
  const onCloseSide = files !== undefined ? onCloseFiles : onCloseInspector;

  const body = useRef<HTMLDivElement>(null);
  const floatingInspector = useRef<HTMLElement>(null);
  const bodyWidth = useWidthOf(body);
  const [savedSidebar, setSavedSidebar, rememberSidebar] = usePanelWidth(SIDEBAR.key, SIDEBAR.fallback);
  const [savedInspector, setSavedInspector, rememberInspector] = usePanelWidth(
    INSPECTOR.key,
    INSPECTOR.fallback,
  );
  const [savedFiles, setSavedFiles, rememberFiles] = usePanelWidth(FILES.key, FILES.fallback);
  /** Which panel is being dragged, if any: it follows the pointer rather than easing toward it. */
  const [dragging, setDragging] = useState<"sidebar" | "inspector">();

  const { sidebarWidth, sidebarMax, sidebarSpace, floating, inspectorWidth, inspectorMax } = panelLayout(
    bodyWidth,
    { sidebar: savedSidebar, inspector: files !== undefined ? savedFiles : savedInspector },
    showSidebar,
    sideSpec,
  );

  const inspectorHandle = (
    <ResizeHandle
      label={files !== undefined ? "Resize files panel" : "Resize agents panel"}
      edge="start"
      width={inspectorWidth}
      min={sideSpec.min}
      max={inspectorMax}
      fallback={sideSpec.fallback}
      onResize={files !== undefined ? setSavedFiles : setSavedInspector}
      onCommit={files !== undefined ? rememberFiles : rememberInspector}
      onDragChange={(active) => setDragging(active ? "inspector" : undefined)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar
        {...(thread ? { thread } : {})}
        settingsOpen={settings.open}
        mode={mode}
        onModeChange={onModeChange}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        resizing={dragging === "sidebar"}
        onToggleSidebar={onToggleSidebar}
        onNewThread={onNewThread}
        agents={agents}
        inspectorOpen={inspector !== undefined}
        onToggleInspector={onToggleInspector}
        {...(filesAvailable ? { files: { open: filesOpen, onToggle: onToggleFiles } } : {})}
        {...(terminal ? { terminal } : {})}
        machinePicker={machinePicker}
        tabs={tabs}
      />
      <div ref={body} className="relative flex min-h-0 flex-1 pr-1.5 pb-1.5">
        {/* The sidebar keeps its width while the frame around it folds, so its rows don't reflow. */}
        <aside
          inert={!showSidebar}
          style={{ width: sidebarSpace }}
          className={`shrink-0 overflow-hidden ${
            dragging === "sidebar" ? "" : "transition-[width,opacity] duration-200 ease-out-soft"
          } ${showSidebar ? "opacity-100" : "opacity-0"}`}
        >
          <div className="h-full" style={{ width: sidebarWidth - GUTTER }}>
            <ViewStack
              active={view}
              views={[
                ["threads", sidebar],
                ["settings", settings.nav],
              ]}
            />
          </div>
        </aside>
        {showSidebar ? (
          <div className="relative w-0 shrink-0">
            <ResizeHandle
              label="Resize sidebar"
              edge="end"
              width={sidebarWidth}
              min={SIDEBAR.min}
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
              [
                "settings",
                <div
                  key="settings"
                  className="h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised"
                >
                  {settings.page}
                </div>,
              ],
            ]}
          />
        </main>
        {showInspector ? (
          floating ? (
            <>
              {/* On the gutter left of the floating panel. */}
              <div
                className="absolute top-0 bottom-1.5 z-30 w-0"
                style={{ right: inspectorWidth + GUTTER * 2 }}
              >
                {inspectorHandle}
              </div>
              <aside
                ref={floatingInspector}
                style={{ width: inspectorWidth }}
                className="absolute top-0 right-1.5 bottom-1.5 z-20 overflow-hidden rounded-xl border border-line-strong bg-surface-overlay shadow-overlay backdrop-blur-2xl"
              >
                <SidePanelContext value={{ floating: true, close: onCloseSide }}>{side}</SidePanelContext>
              </aside>
            </>
          ) : (
            <>
              <div className="relative w-0 shrink-0">{inspectorHandle}</div>
              <aside
                style={{ width: inspectorWidth }}
                className="ml-1.5 shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised"
              >
                <SidePanelContext value={{ floating: false, close: onCloseSide }}>{side}</SidePanelContext>
              </aside>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * The phone-narrow window: one pane at a time, each under its own top
 * bar with the way back, and a thread's agents over the thread. Every pane stays mounted, so going
 * back finds it as it was left.
 */
function CompactFrame({
  thread,
  mode,
  onModeChange,
  sidebar,
  agents,
  inspector,
  onToggleInspector,
  files,
  filesAvailable,
  filesOpen,
  onToggleFiles,
  terminal,
  settings,
  machinePicker,
  closeDialog,
  pane,
  onBack,
  children,
}: AppFrameProps) {
  const listLabel = mode === "work" ? "Inbox" : "Chats";
  const keyboardOpen = useKeyboardOpen();
  const view = settings.open ? (settings.pane === "nav" ? "settings" : "category") : pane;
  const side = inspector ?? files;
  const inspecting = side !== undefined && !settings.open && pane === "main";
  // The terminal is a pane over the thread, and the agents or files a pane over that.
  const terminalOpen = terminal?.open === true && !settings.open && pane === "main";
  const inspectDepth = 2 + (terminalOpen ? 1 : 0);
  // How many panes down the window is, a dialog over it counting as one more: the phone's own Back
  // button takes it up one.
  useBackNavigation(
    (settings.open
      ? settings.pane === "nav"
        ? 1
        : 2
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
      } else if (inspecting) (files !== undefined ? onToggleFiles : onToggleInspector)();
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
                  <div className="flex items-center gap-2 pl-2">
                    <CeriumMark size={18} landing className="text-fg-primary" />
                    <ModeSwitch mode={mode} onChange={onModeChange} />
                  </div>
                }
                trailing={machinePicker}
              />
              <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">{sidebar}</div>
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
                {...(agents.length > 0 || filesAvailable || terminal
                  ? {
                      trailing: (
                        <>
                          {terminal ? (
                            <TerminalToggle open={terminal.open} onToggle={terminal.onToggle} />
                          ) : null}
                          {filesAvailable ? <FilesToggle open={filesOpen} onToggle={onToggleFiles} /> : null}
                          {agents.length > 0 ? (
                            <AgentsToggle
                              agents={agents}
                              open={inspector !== undefined}
                              onToggle={onToggleInspector}
                            />
                          ) : null}
                        </>
                      ),
                    }
                  : {})}
              />
              <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
            </div>,
          ],
          [
            "settings",
            <div key="settings" className="flex h-full flex-col">
              <CompactBar back={{ label: listLabel, onBack: settings.onClose }} title="Settings" />
              <div className="min-h-0 flex-1">{settings.nav}</div>
            </div>,
          ],
          [
            "category",
            <div key="category" className="flex h-full flex-col">
              <CompactBar back={{ label: "Settings", onBack: settings.onBackToNav }} title={settings.title} />
              <div className="min-h-0 flex-1">{settings.page}</div>
            </div>,
          ],
        ]}
      />
      {inspecting ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-surface-panel pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl">
          {side}
        </div>
      ) : null}
    </div>
  );
}
