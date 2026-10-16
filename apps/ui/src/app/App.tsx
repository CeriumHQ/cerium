import { useState } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { threadFixtures } from "../dev/fixtures.ts";
import { leadFixture, transcriptFixture } from "../dev/transcriptFixture.ts";
import { Sidebar } from "../features/threads/Sidebar.tsx";
import { buildTranscript } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
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
        agents={["claude", "muse", "muse"]}
        inspector={inspectorOpen ? <div /> : undefined}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      >
        <Transcript
          blocks={buildTranscript(transcriptFixture)}
          agent={leadFixture}
          childState={() => "idle"}
        />
      </AppFrame>
    </TooltipProvider>
  );
}
