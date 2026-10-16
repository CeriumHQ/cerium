import type { ProviderId } from "@cerium/protocol";
import type { ReactNode } from "react";

import type { AppMode } from "./ModeSwitch.tsx";
import { Titlebar } from "./Titlebar.tsx";

interface AppFrameProps {
  readonly mode: AppMode;
  readonly onModeChange: (mode: AppMode) => void;
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
 * transcript, which floats above it as an inset card. The inspector opens beside it on demand.
 */
export function AppFrame({
  mode,
  onModeChange,
  sidebar,
  agents,
  inspector,
  onToggleInspector,
  children,
}: AppFrameProps) {
  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar
        mode={mode}
        onModeChange={onModeChange}
        agents={agents}
        inspectorOpen={inspector !== undefined}
        onToggleInspector={onToggleInspector}
      />
      <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5">
        <aside className="w-68 shrink-0">{sidebar}</aside>
        <main className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
          {children}
        </main>
        {inspector === undefined ? null : (
          <aside className="w-80 shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
            {inspector}
          </aside>
        )}
      </div>
    </div>
  );
}
