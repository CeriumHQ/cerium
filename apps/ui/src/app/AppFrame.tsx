import type { ProviderId } from "@cerium/protocol";
import type { ReactNode } from "react";

import { CeriumMark } from "../components/CeriumMark.tsx";
import { ViewStack } from "../components/ViewStack.tsx";
import { CompactBar } from "./CompactBar.tsx";
import { useCompact } from "./compact.ts";
import { ModeSwitch, type AppMode } from "./ModeSwitch.tsx";
import { AgentsToggle, Titlebar } from "./Titlebar.tsx";

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
  readonly children: ReactNode;
}

/**
 * The window: a titlebar over the thread sidebar, which sits directly on the window's glass, and the
 * transcript, which floats above it as an inset card. The sidebar folds away on demand (settings always
 * show theirs); the inspector opens beside the transcript on demand.
 */
export function AppFrame({
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
  settings,
  machinePicker,
  pane,
  onBack,
  children,
}: AppFrameProps) {
  const compact = useCompact();
  if (compact) {
    return (
      <CompactFrame
        mode={mode}
        onModeChange={onModeChange}
        sidebar={sidebar}
        agents={agents}
        inspector={inspector}
        onToggleInspector={onToggleInspector}
        settings={settings}
        pane={pane}
        onBack={onBack}
        {...(thread ? { thread } : {})}
        {...(machinePicker === undefined ? {} : { machinePicker })}
      >
        {children}
      </CompactFrame>
    );
  }
  const view = settings.open ? "settings" : "threads";
  const showSidebar = sidebarOpen || settings.open;
  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar
        {...(thread ? { thread } : {})}
        settingsOpen={settings.open}
        mode={mode}
        onModeChange={onModeChange}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        onNewThread={onNewThread}
        agents={agents}
        inspectorOpen={inspector !== undefined}
        onToggleInspector={onToggleInspector}
        machinePicker={machinePicker}
      />
      <div className="flex min-h-0 flex-1 pr-1.5 pb-1.5">
        {/* The sidebar keeps its width while the frame around it folds, so its rows don't reflow. */}
        <aside
          inert={!showSidebar}
          className={`shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out-soft ${
            showSidebar ? "w-69.5 opacity-100" : "w-1.5 opacity-0"
          }`}
        >
          <div className="h-full w-68">
            <ViewStack
              active={view}
              views={[
                ["threads", sidebar],
                ["settings", settings.nav],
              ]}
            />
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
          <ViewStack
            active={view}
            views={[
              ["threads", children],
              ["settings", settings.page],
            ]}
          />
        </main>
        {inspector === undefined || settings.open ? null : (
          <aside className="ml-1.5 w-80 shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
            {inspector}
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * The phone-narrow window (docs/architecture.md §14.10): one pane at a time, each under its own top
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
  settings,
  machinePicker,
  pane,
  onBack,
  children,
}: Omit<AppFrameProps, "sidebarOpen" | "onToggleSidebar" | "onNewThread">) {
  const listLabel = mode === "work" ? "Inbox" : "Chats";
  const view = settings.open ? (settings.pane === "nav" ? "settings" : "category") : pane;
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
                    <CeriumMark size={18} className="text-fg-primary" />
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
                title={thread?.title ?? (mode === "work" ? "New thread" : "New chat")}
                {...(thread?.project ? { subtitle: thread.project } : {})}
                {...(agents.length > 0
                  ? {
                      trailing: (
                        <AgentsToggle
                          agents={agents}
                          open={inspector !== undefined}
                          onToggle={onToggleInspector}
                        />
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
      {inspector !== undefined && !settings.open && pane === "main" ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-surface-panel pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl">
          {inspector}
        </div>
      ) : null}
    </div>
  );
}
