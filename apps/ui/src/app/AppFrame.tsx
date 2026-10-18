import type { ProviderId } from "@cerium/protocol";
import type { ReactNode } from "react";

import { ViewStack } from "../components/ViewStack.tsx";
import type { AppMode } from "./ModeSwitch.tsx";
import { Titlebar } from "./Titlebar.tsx";

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
  readonly settings: { readonly open: boolean; readonly nav: ReactNode; readonly page: ReactNode };
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
  children,
}: AppFrameProps) {
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
