import { useState } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { threadFixtures } from "../dev/fixtures.ts";
import { Sidebar } from "../features/threads/Sidebar.tsx";
import { AppFrame } from "./AppFrame.tsx";

export function App() {
  const [selectedThread, setSelectedThread] = useState<string | undefined>("t1");
  return (
    <TooltipProvider delay={400}>
      <AppFrame
        sidebar={
          <Sidebar threads={threadFixtures} selectedId={selectedThread} onSelect={setSelectedThread} />
        }
        inspector={<Placeholder label="Agents" />}
      >
        <Placeholder label="Conversation" />
      </AppFrame>
    </TooltipProvider>
  );
}

function Placeholder({ label }: { label: string }) {
  return <div className="grid h-full place-items-center text-sm text-fg-tertiary">{label}</div>;
}
