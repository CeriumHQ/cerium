import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { ThreadLog } from "../src/backend/threadLog.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";

const event = (sequence: number, payload: EventPayload, at = sequence): AgentEvent => ({
  id: `a:${sequence}` as EventId,
  threadId: "t" as ThreadId,
  agentId: "a" as AgentId,
  sequence,
  at,
  payload,
});

const ids = (log: ThreadLog) => log.snapshot().map((each) => each.id);

describe("ThreadLog", () => {
  it("keeps each event once, whether history or the live feed brings it", () => {
    const log = new ThreadLog();
    const first = event(0, { _tag: "TurnCompleted", stopReason: "completed" });
    const second = event(1, { _tag: "AgentStateChanged", state: "idle" });
    expect(log.add([first])).toBe(true);
    expect(log.add([first, second])).toBe(true);
    expect(log.add([second])).toBe(false);
    expect(ids(log)).toEqual(["a:0", "a:1"]);
  });

  it("puts history that arrives after live events back in time order", () => {
    const log = new ThreadLog();
    log.add([event(5, { _tag: "AgentStateChanged", state: "running" })]);
    log.add([
      event(3, { _tag: "MessageQueued", message: { _tag: "FromUser", text: "hi" } }),
      event(4, { _tag: "AgentStateChanged", state: "queued" }),
    ]);
    expect(ids(log)).toEqual(["a:3", "a:4", "a:5"]);
  });

  it("drops a completed block's deltas but its first, so the block keeps its place", () => {
    const log = new ThreadLog();
    log.add([
      event(0, { _tag: "MessageDelta", messageId: "m", text: "Hel" }),
      event(1, { _tag: "ToolCallStarted", callId: "c", toolName: "read", input: {} }),
      event(2, { _tag: "MessageDelta", messageId: "m", text: "lo" }),
    ]);
    log.add([event(3, { _tag: "MessageCompleted", messageId: "m", text: "Hello" })]);
    expect(ids(log)).toEqual(["a:0", "a:1", "a:3"]);
    expect(buildTranscript(log.snapshot()).map((block) => block.kind)).toEqual(["message", "tool"]);
    expect(buildTranscript(log.snapshot())[0]).toMatchObject({ text: "Hello", streaming: false });
  });

  it("ignores deltas that arrive after their block completed", () => {
    const log = new ThreadLog();
    log.add([event(0, { _tag: "ReasoningCompleted", messageId: "r", text: "Thought" })]);
    expect(log.add([event(1, { _tag: "ReasoningDelta", messageId: "r", text: "late" })])).toBe(false);
    expect(buildTranscript(log.snapshot())).toEqual([
      { kind: "reasoning", id: "reasoning:r", text: "Thought", streaming: false },
    ]);
  });

  it("keeps the deltas of a block still streaming", () => {
    const log = new ThreadLog();
    log.add([
      event(0, { _tag: "MessageDelta", messageId: "m", text: "Hel" }),
      event(1, { _tag: "MessageDelta", messageId: "m", text: "lo" }),
    ]);
    expect(buildTranscript(log.snapshot())).toEqual([
      { kind: "message", id: "message:m", text: "Hello", streaming: true },
    ]);
  });

  it("hands each reader a copy it can keep", () => {
    const log = new ThreadLog();
    log.add([event(0, { _tag: "AgentStateChanged", state: "idle" })]);
    const before = log.snapshot();
    log.add([event(1, { _tag: "AgentStateChanged", state: "running" })]);
    expect(before).toHaveLength(1);
    expect(log.snapshot()).toHaveLength(2);
  });
});
