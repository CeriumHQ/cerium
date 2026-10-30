import type { AgentEvent, EventId } from "@cerium/protocol";
import { useEffect, useState } from "react";

import { ThreadLog } from "../backend/threadLog.ts";
import { useTheme } from "../features/settings/theme.ts";
import { IncrementalTranscript } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { diagrams, explanation, leadFixture, transcriptFixture } from "./transcriptFixture.ts";

// The transcript on its own, drawn from the fixture, for building and screenshotting its components
// without running an agent: `?playground` in the dev server. `&working` approves the waiting push and
// leaves it running; `&diagrams` swaps the explaining reply for one with a diagram and math; `&stream` replays the explaining reply as it would stream in, and `&at=<n>`
// holds it at its nth character.
// &history=5000 starts with a long settled log; &grow=300 appends completed turns to it.

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
const streamed = (reply: string, characters: number): ReadonlyArray<AgentEvent> => {
  return [
    approved,
    after(2, {
      _tag: "ToolCallCompleted",
      callId: "c11",
      output: "branch 'fix/session-race' set up",
      isError: false,
    }),
    after(3, { _tag: "MessageDelta", messageId: "stream", text: reply.slice(0, characters), offset: 0 }),
    ...(characters >= reply.length
      ? [after(4, { _tag: "MessageCompleted", messageId: "stream", text: reply })]
      : []),
  ];
};

const sameModel = (a: string, b: string) => a === b;
// Keep the changing input explicit for the React Compiler's cached reads.
const updateLog = (log: ThreadLog, events: ReadonlyArray<AgentEvent>) => {
  log.add(events);
  return log.state();
};
const syntheticTurn = (n: number, base: number, at: number): ReadonlyArray<AgentEvent> => [
  {
    ...last,
    id: `synthetic:input:${n}` as EventId,
    sequence: base,
    at,
    payload: {
      _tag: "TurnInput",
      items: [{ _tag: "FromUser", id: `synthetic:user:${n}`, text: `Synthetic prompt ${n}` }],
    },
  },
  {
    ...last,
    id: `synthetic:reply:${n}` as EventId,
    sequence: base + 1,
    at: at + 1,
    payload: { _tag: "MessageCompleted", messageId: `synthetic:${n}`, text: `Settled answer ${n}.` },
  },
  {
    ...last,
    id: `synthetic:end:${n}` as EventId,
    sequence: base + 2,
    at: at + 2,
    payload: { _tag: "TurnCompleted", stopReason: "completed" },
  },
];

export function Playground() {
  // The colour scheme the page sees, so `bun run ui --light` shows the light theme.
  useTheme("system");
  const search = new URLSearchParams(location.search);
  const size = Math.max(0, Math.min(5000, Number(search.get("history") ?? 0)));
  const growth = Math.max(0, Math.min(500, Number(search.get("grow") ?? 0)));
  // `&at=600` holds the stream at its 600th character, for a screenshot of a reply mid-write.
  const held = search.has("at") ? Number(search.get("at")) : undefined;
  const streaming = growth === 0 && (search.has("stream") || search.has("diagrams") || held !== undefined);
  const fence = search.get("fence");
  const reply =
    fence === null
      ? search.has("diagrams")
        ? diagrams
        : explanation
      : `Large streaming fence.\n\n\`\`\`${fence}\n${"const value = 123;\n".repeat(10_000)}\`\`\`\n\nFinished.`;
  const [characters, setCharacters] = useState(held ?? (streaming ? 0 : reply.length));
  useEffect(() => {
    if (!streaming || held !== undefined) return;
    const timer = setInterval(() => setCharacters((count) => Math.min(reply.length, count + 9)), 40);
    return () => clearInterval(timer);
  }, [streaming, held, reply]);
  const [grown, setGrown] = useState(0);
  useEffect(() => {
    if (growth === 0) return;
    const timer = setInterval(
      () =>
        setGrown((count) => {
          if (count >= growth) clearInterval(timer);
          return Math.min(growth, count + 1);
        }),
      40,
    );
    return () => clearInterval(timer);
  }, [growth]);
  const [log] = useState(() => {
    const log = new ThreadLog();
    for (let n = 0; n < size; n++)
      log.add(syntheticTurn(n, n * 3, transcriptFixture[0]!.at - (size - n) * 3));
    log.add(transcriptFixture.map((event) => ({ ...event, sequence: event.sequence + size * 3 })));
    return log;
  });
  const [projection] = useState(() => new IncrementalTranscript());
  const events = streaming
    ? streamed(reply, characters).map((event) => ({ ...event, sequence: event.sequence + size * 3 }))
    : search.has("working")
      ? [{ ...approved, sequence: approved.sequence + size * 3 }]
      : [];
  for (let n = 0; n < grown; n++)
    events.push(...syntheticTurn(size + n, size * 3 + last.sequence + 100 + n * 3, last.at + 100 + n * 3));
  const agent = updateLog(log, events).agents.get(last.agentId)!;
  const transcript = projection.project(agent.events, agent.generation, sameModel);
  return (
    <div className="h-full bg-surface-window p-1.5">
      <div className="h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised">
        <Transcript
          blocks={transcript.blocks}
          queued={transcript.queued}
          live={agent.live}
          agent={{ provider: leadFixture.provider }}
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
