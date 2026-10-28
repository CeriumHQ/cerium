import type { AgentEvent, EventId } from "@cerium/protocol";
import { useEffect, useState } from "react";

import { useTheme } from "../features/settings/theme.ts";
import { buildTranscript, queuedMessages } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { explanation, leadFixture, transcriptFixture } from "./transcriptFixture.ts";

// The transcript on its own, drawn from the fixture, for building and screenshotting its components
// without running an agent: `?playground` in the dev server. `&working` approves the waiting push and
// leaves it running; `&stream` replays the explaining reply as it would stream in, and `&at=<n>`
// holds it at its nth character.

const last = transcriptFixture.at(-1)!;

const after = (sequence: number, payload: AgentEvent["payload"]): AgentEvent => ({
  ...last,
  id: `stream:${sequence}` as EventId,
  sequence: last.sequence + sequence,
  at: last.at + sequence,
  payload,
});

const approved = after(1, { _tag: "PermissionResolved", requestId: "c11", decision: "allow", scope: "once" });

/** The explaining reply, streamed in again as a new turn, a few characters every frame. */
const streamed = (characters: number): ReadonlyArray<AgentEvent> => {
  return [
    approved,
    after(2, {
      _tag: "ToolCallCompleted",
      callId: "c11",
      output: "branch 'fix/session-race' set up",
      isError: false,
    }),
    after(3, { _tag: "MessageDelta", messageId: "stream", text: explanation.slice(0, characters) }),
  ];
};

export function Playground() {
  // The colour scheme the page sees, so `bun run ui --light` shows the light theme.
  useTheme("system");
  const search = new URLSearchParams(location.search);
  // `&at=600` holds the stream at its 600th character, for a screenshot of a reply mid-write.
  const held = search.has("at") ? Number(search.get("at")) : undefined;
  const streaming = search.has("stream") || held !== undefined;
  const [characters, setCharacters] = useState(held ?? (streaming ? 0 : explanation.length));
  useEffect(() => {
    if (!streaming || held !== undefined) return;
    const timer = setInterval(() => setCharacters((count) => Math.min(explanation.length, count + 9)), 40);
    return () => clearInterval(timer);
  }, [streaming, held]);
  const events = streaming
    ? [...transcriptFixture, ...streamed(characters)]
    : search.has("working")
      ? [...transcriptFixture, approved]
      : transcriptFixture;
  return (
    <div className="h-full bg-surface-window p-1.5">
      <div className="h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised">
        <Transcript
          blocks={buildTranscript(events)}
          queued={queuedMessages(events)}
          agent={{ provider: leadFixture.provider, model: leadFixture.model }}
          folder="C:/work/acme-web"
          activity="running"
          childState={(id) => (id === "agt_scout1" ? "idle" : "running")}
          childAgent={() => undefined}
          agentActions={{}}
          onAnswerPermission={() => undefined}
        />
      </div>
    </div>
  );
}
