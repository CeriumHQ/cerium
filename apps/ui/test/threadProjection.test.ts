import {
  isStreamDelta,
  type AgentEvent,
  type AgentId,
  type EventId,
  type EventPayload,
  type ThreadId,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { inHistoryWindow, ThreadLog } from "../src/backend/threadLog.ts";
import {
  buildTranscript,
  IncrementalTranscript,
  queuedMessages,
  type TranscriptBlock,
} from "../src/features/transcript/model.ts";

const sameModel = (a: string, b: string) => a === b;
const lead = "a" as AgentId;
const event = (sequence: number, payload: EventPayload, agentId = lead): AgentEvent => ({
  id: `${agentId}:${sequence}` as EventId,
  agentId,
  threadId: "t" as ThreadId,
  at: sequence,
  sequence,
  payload,
});
const turn = (id: string): EventPayload => ({
  _tag: "TurnInput",
  items: [{ _tag: "FromUser", id, text: id }],
});

const project = (log: ThreadLog, projection: IncrementalTranscript) => {
  const history = log.state().agents.get(lead)!;
  const overlay = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<TranscriptBlock> =>
    blocks.map((block) => {
      const payload = history.live.get(block.id)?.payload;
      if (
        (block.kind === "message" || block.kind === "reasoning") &&
        (payload?._tag === "MessageDelta" || payload?._tag === "ReasoningDelta")
      )
        return { ...block, text: payload.text };
      return block.kind === "replaced" ? { ...block, blocks: overlay(block.blocks) } : block;
    });
  return overlay(projection.read(history.events, history.generation, sameModel));
};

describe("incremental transcript", () => {
  it("matches replay through deltas, completions, queued inputs, rewinds and out-of-order older pages", () => {
    const payloads: ReadonlyArray<EventPayload> = [
      turn("one"),
      { _tag: "MessageDelta", messageId: "m", text: "hel", offset: 0 },
      { _tag: "ToolCallStarted", callId: "c", toolName: "read", input: {} },
      { _tag: "MessageDelta", messageId: "m", text: "lo", offset: 3 },
      { _tag: "MessageCompleted", messageId: "m", text: "hello" },
      { _tag: "TurnCompleted", stopReason: "completed" },
      { _tag: "MessageQueued", message: { _tag: "FromUser", id: "two", text: "two" } },
      turn("two"),
      { _tag: "ReasoningDelta", messageId: "r", text: "thought", offset: 0 },
      { _tag: "ReasoningCompleted", messageId: "r", text: "thought" },
      { _tag: "ConversationRewound", messageId: "two", fromSequence: 7, via: "fork" },
      turn("three"),
      { _tag: "MessageCompleted", messageId: "n", text: "done" },
    ];
    const log = new ThreadLog();
    const projection = new IncrementalTranscript();
    for (const [n, payload] of payloads.entries()) {
      log.add([event(n, payload)]);
      expect(project(log, projection)).toEqual(buildTranscript(log.snapshot()));
      expect(project(log, projection)).toEqual(
        buildTranscript(payloads.slice(0, n + 1).map((p, index) => event(index, p))),
      );
      expect(projection.queued).toEqual(queuedMessages(log.snapshot()));
    }
    const older = event(0, turn("old"));
    const lateLog = new ThreadLog();
    const lateProjection = new IncrementalTranscript();
    lateLog.add(payloads.slice(4).map((p, n) => event(n + 4, p)));
    project(lateLog, lateProjection);
    lateLog.add([older, ...payloads.slice(1, 4).map((p, n) => event(n + 1, p))]);
    expect(project(lateLog, lateProjection)).toEqual(buildTranscript(lateLog.snapshot()));
  });

  it("keeps settled history, lead state, blocks and queue identical through words from any agent", () => {
    const log = new ThreadLog();
    const projection = new IncrementalTranscript();
    log.add([
      event(0, turn("one")),
      event(1, { _tag: "MessageCompleted", messageId: "old", text: "settled" }),
      event(2, { _tag: "MessageDelta", messageId: "m", text: "a", offset: 0 }),
    ]);
    const first = log.state();
    const agent = first.agents.get(lead)!;
    const blocks = projection.read(agent.events, agent.generation, sameModel);
    const view = projection.project(agent.events, agent.generation, sameModel);
    const queue = projection.queued;
    log.add([event(3, { _tag: "MessageDelta", messageId: "m", text: "b", offset: 1 })]);
    const second = log.state();
    const next = second.agents.get(lead)!;
    expect(second.settled).toBe(first.settled);
    expect(next.events).toBe(agent.events);
    expect(projection.read(next.events, next.generation, sameModel)).toBe(blocks);
    expect(projection.queued).toBe(queue);
    expect(projection.project(next.events, next.generation, sameModel)).toBe(view);
    const child = "child" as AgentId;
    log.add([event(0, { _tag: "MessageDelta", messageId: "m", text: "child", offset: 0 }, child)]);
    expect(log.state().agents.get(lead)).toBe(next);
    expect(project(log, projection)[1]).toMatchObject({ text: "settled" });
    expect(project(log, projection)[2]).toMatchObject({ text: "ab" });
    log.add([
      event(4, { _tag: "MessageQueued", message: { _tag: "FromUser", id: "waiting", text: "next" } }),
    ]);
    const waiting = log.state().agents.get(lead)!;
    expect(projection.project(waiting.events, waiting.generation, sameModel).queued.messages[0]?.id).toBe(
      "waiting",
    );
  });

  it("fills a reconnect gap before consuming queued offsets and preserves interrupted text", () => {
    const log = new ThreadLog();
    const projection = new IncrementalTranscript();
    log.add([
      event(0, turn("one")),
      event(1, { _tag: "MessageDelta", messageId: "m", text: "hello", offset: 0 }),
    ]);
    log.add([event(3, { _tag: "MessageDelta", messageId: "m", text: "world", offset: 6 })]);
    log.add([
      {
        ...event(1, { _tag: "MessageDelta", messageId: "m", text: "hello ", offset: 0 }),
        id: "snapshot" as EventId,
      },
    ]);
    expect(project(log, projection)[1]).toMatchObject({ text: "hello world" });
    log.add([event(4, { _tag: "TurnCompleted", stopReason: "interrupted" })]);
    expect(project(log, projection)[1]).toMatchObject({ text: "hello world" });
    expect(log.state().agents.get(lead)?.live.size).toBe(0);
  });

  it("keeps a current stream alive when an older page contains terminal events", () => {
    const log = new ThreadLog();
    const projection = new IncrementalTranscript();
    log.add([
      event(10, turn("current")),
      event(11, { _tag: "MessageDelta", messageId: "m", text: "hello", offset: 0 }),
    ]);
    project(log, projection);
    log.add([
      event(0, turn("old")),
      event(1, { _tag: "TurnCompleted", stopReason: "completed" }),
      event(2, { _tag: "AgentStateChanged", state: "idle" }),
      event(3, { _tag: "ConversationRewound", messageId: "old", fromSequence: 0, via: "fork" }),
    ]);
    log.add([event(12, { _tag: "MessageDelta", messageId: "m", text: " world", offset: 5 })]);
    expect(log.state().agents.get(lead)?.live.size).toBe(1);
    expect(project(log, projection).at(-1)).toMatchObject({ text: "hello world" });
    expect(project(log, projection)).toEqual(buildTranscript(log.snapshot()));
  });

  it("ignores a queued delta from a turn that catch-up already ended, then accepts the next turn", () => {
    const log = new ThreadLog();
    log.add([event(4, { _tag: "TurnCompleted", stopReason: "interrupted" })]);
    expect(log.add([event(3, { _tag: "MessageDelta", messageId: "old", text: "late", offset: 0 })])).toBe(
      false,
    );
    log.add([
      event(5, turn("next")),
      event(6, { _tag: "MessageDelta", messageId: "new", text: "next", offset: 0 }),
    ]);
    expect([...log.state().agents.get(lead)!.live.keys()]).toEqual(["message:new"]);
  });
});

it("holds a late import below the suffix until older pages fill its context", () => {
  const log = new ThreadLog();
  const projection = new IncrementalTranscript();
  const latest = event(20, turn("latest"));
  const imported = event(2, turn("imported"));
  log.add([latest]);
  const held = project(log, projection);
  log.add([imported].filter((each) => inHistoryWindow(each, latest, true)));
  expect(project(log, projection)).toEqual(held);
  log.add([imported, event(10, turn("middle"))]);
  expect(project(log, projection)).toEqual(buildTranscript(log.snapshot()));
  expect(project(log, projection).map((block) => block.id)).toEqual(["imported", "middle", "latest"]);
  expect(inHistoryWindow(imported, latest, false)).toBe(true);
});

it("does not attach restored files to an earlier rewind when the latest rewind replaced nothing", () => {
  const blocks = buildTranscript([
    event(0, turn("old")),
    event(1, { _tag: "ConversationRewound", messageId: "old", fromSequence: 0, via: "fork" }),
    event(2, { _tag: "ConversationRewound", messageId: "unloaded", fromSequence: 99, via: "fork" }),
    event(3, { _tag: "FilesRestored", messageId: "unloaded", paths: ["unloaded.ts"] }),
  ]);
  expect(blocks[0]).toMatchObject({ kind: "replaced" });
  expect(blocks[0]).not.toHaveProperty("files");
});

it("measures the pre-render data path on the same synthetic histories", () => {
  if (process.env.CERIUM_PERF !== "1") return;
  for (const size of [50_000, 100_000]) {
    const log = new ThreadLog();
    log.add(
      Array.from({ length: size }, (_, n) =>
        event(
          n,
          n % 3 === 0
            ? turn(`q${n}`)
            : n % 3 === 1
              ? { _tag: "MessageCompleted", messageId: `m${n}`, text: "A settled answer." }
              : { _tag: "TurnCompleted", stopReason: "completed" },
        ),
      ),
    );
    log.add([event(size, { _tag: "MessageDelta", messageId: "live", text: "x", offset: 0 })]);
    const projection = new IncrementalTranscript();
    project(log, projection);
    // Ordered appends: the old log's snapshot was a slice of this array, including each live delta.
    const before = [...log.snapshot()];
    const baseline: Array<number> = [];
    const incremental: Array<number> = [];
    for (let n = 1; n <= 40; n++) {
      const delta = event(size + n, { _tag: "MessageDelta", messageId: "live", text: "x", offset: n });
      before.push(delta);
      let started = performance.now();
      log.add([delta]);
      const state = log.state();
      const agent = state.agents.get(lead)!;
      const projected = projection.project(agent.events, agent.generation, sameModel);
      incremental.push(performance.now() - started);
      expect(projected.queued).toBeDefined();
      started = performance.now();
      const all = before.slice();
      const filtered = all.filter((e) => e.agentId === lead);
      buildTranscript(filtered);
      queuedMessages(filtered);
      all.filter((e) => !isStreamDelta(e.payload._tag));
      baseline.push(performance.now() - started);
    }
    const median = (times: Array<number>) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    console.log(
      JSON.stringify({
        events: size,
        baselineMedianMs: median(baseline),
        incrementalMedianMs: median(incremental),
      }),
    );
  }
});
