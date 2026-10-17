import { useState } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { agentsFixture } from "../dev/agentsFixture.ts";
import { threadFixtures } from "../dev/fixtures.ts";
import { leadFixture, transcriptFixture } from "../dev/transcriptFixture.ts";
import { Inspector } from "../features/agents/Inspector.tsx";
import { Composer } from "../features/composer/Composer.tsx";
import { Sidebar } from "../features/threads/Sidebar.tsx";
import { buildTranscript } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { AppFrame } from "./AppFrame.tsx";
import type { AppMode } from "./ModeSwitch.tsx";

export function App() {
  const [selectedThread, setSelectedThread] = useState<string | undefined>("t1");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>("work");
  return (
    <TooltipProvider delay={400}>
      <AppFrame
        mode={mode}
        onModeChange={setMode}
        sidebar={
          <Sidebar
            mode={mode}
            threads={threadFixtures}
            selectedId={selectedThread}
            onSelect={setSelectedThread}
          />
        }
        agents={agentsFixture.map((agent) => agent.provider)}
        inspector={
          inspectorOpen ? (
            <Inspector agents={agentsFixture} onClose={() => setInspectorOpen(false)} />
          ) : undefined
        }
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      >
        <div className="relative h-full">
          <Transcript
            blocks={buildTranscript(transcriptFixture)}
            agent={leadFixture}
            childState={() => "idle"}
          />
          <Composer running={false} onSend={() => undefined} onStop={() => undefined} />
        </div>
      </AppFrame>
    </TooltipProvider>
  );
}
