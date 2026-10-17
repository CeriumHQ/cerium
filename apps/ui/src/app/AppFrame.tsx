import type { ProviderId } from "@cerium/protocol";
import type { ReactNode } from "react";

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
  readonly children: ReactNode;
}

/**
 * The window: a titlebar over the thread sidebar, which sits directly on the window's glass, and the
 * transcript, which floats above it as an inset card. The sidebar folds away on demand; the inspector
 * opens beside the transcript on demand.
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
  children,
}: AppFrameProps) {
  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar
        {...(thread ? { thread } : {})}
        mode={mode}
        onModeChange={onModeChange}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        onNewThread={onNewThread}
        agents={agents}
        inspectorOpen={inspector !== undefined}
        onToggleInspector={onToggleInspector}
      />
      <div className="flex min-h-0 flex-1 pr-1.5 pb-1.5">
        {/* The sidebar keeps its width while the frame around it folds, so its rows don't reflow. */}
        <aside
          inert={!sidebarOpen}
          className={`shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out-soft ${
            sidebarOpen ? "w-69.5 opacity-100" : "w-1.5 opacity-0"
          }`}
        >
          <div className="h-full w-68">{sidebar}</div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
          {children}
        </main>
        {inspector === undefined ? null : (
          <aside className="ml-1.5 w-80 shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
            {inspector}
          </aside>
        )}
      </div>
    </div>
  );
}
