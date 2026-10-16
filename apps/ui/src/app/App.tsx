import { useState } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { threadFixtures } from "../dev/fixtures.ts";
import { Sidebar } from "../features/threads/Sidebar.tsx";
import { AppFrame } from "./AppFrame.tsx";

export function App() {
  const [selectedThread, setSelectedThread] = useState<string | undefined>("t1");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return (
    <TooltipProvider delay={400}>
      <AppFrame
        sidebar={
          <Sidebar threads={threadFixtures} selectedId={selectedThread} onSelect={setSelectedThread} />
        }
        inspector={inspectorOpen ? <div /> : undefined}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      >
        <div />
      </AppFrame>
    </TooltipProvider>
  );
}
