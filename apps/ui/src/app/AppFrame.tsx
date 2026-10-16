import type { ReactNode } from "react";

import { Titlebar } from "./Titlebar.tsx";

interface AppFrameProps {
  readonly sidebar: ReactNode;
  readonly inspector: ReactNode;
  readonly children: ReactNode;
}

/**
 * The window: a titlebar over three regions. The thread sidebar sits directly on the window's glass;
 * the conversation and the agent inspector float above it as inset cards.
 */
export function AppFrame({ sidebar, inspector, children }: AppFrameProps) {
  return (
    <div className="flex h-full flex-col bg-surface-window">
      <Titlebar />
      <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5">
        <aside className="w-68 shrink-0">{sidebar}</aside>
        <main className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
          {children}
        </main>
        <aside className="w-80 shrink-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
          {inspector}
        </aside>
      </div>
    </div>
  );
}
