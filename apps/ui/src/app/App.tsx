import { useState } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { threadFixtures } from "../dev/fixtures.ts";
import { leadFixture, transcriptFixture } from "../dev/transcriptFixture.ts";
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
        agents={["claude", "muse", "muse"]}
        inspector={inspectorOpen ? <div /> : undefined}
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
