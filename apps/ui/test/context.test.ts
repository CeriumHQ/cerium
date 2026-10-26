import type { AgentEvent, AgentId, AgentInfo, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { toAgentSummaries } from "../src/backend/view.ts";
import { contextLabel } from "../src/features/agents/ContextMeter.tsx";
import { contextFill } from "../src/features/agents/model.ts";
import { layout } from "../src/features/transcript/layout.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "lead" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

const lead = {
  id: "lead",
  threadId: "t",
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  access: "auto",
  state: "idle",
  createdAt: 0,
  updatedAt: 0,
} as unknown as AgentInfo;

const contextOf = (...payloads: ReadonlyArray<EventPayload>) =>
  toAgentSummaries([lead], events(...payloads), [])[0]?.context;

const input = (turnId: string): EventPayload => ({
  _tag: "TurnInput",
  turnId,
  items: [{ _tag: "FromUser", text: "hi" }],
});

describe("an agent's context", () => {
  it("is the latest reading, keeping a window an earlier one gave", () => {
    expect(
      contextOf(
        { _tag: "ContextReported", tokens: 1_000, window: 200_000 },
        { _tag: "ContextReported", tokens: 4_000 },
      ),
    ).toEqual({ tokens: 4_000, window: 200_000 });
  });

  it("is nothing until a harness reports it", () => {
    expect(contextOf({ _tag: "UsageReported", inputTokens: 10, outputTokens: 5 })).toBeUndefined();
  });

  it("takes a compaction's size after, or waits for the next reading without one", () => {
    const before: EventPayload = { _tag: "ContextReported", tokens: 150_000, window: 200_000 };
    expect(
      contextOf(before, {
        _tag: "ContextCompacted",
        trigger: "auto",
        tokensBefore: 150_000,
        tokensAfter: 9_000,
      }),
    ).toEqual({ tokens: 9_000, window: 200_000 });
    expect(contextOf(before, { _tag: "ContextCompacted", trigger: "manual" })).toBeUndefined();
  });

  it("starts over on another harness, and drops the window on another model", () => {
    const reading: EventPayload = { _tag: "ContextReported", tokens: 5_000, window: 200_000 };
    expect(
      contextOf(reading, {
        _tag: "LeadHandedOff",
        from: { provider: "claude", model: "claude-opus-5-5" },
        provider: "codex",
        model: "gpt-5",
      }),
    ).toBeUndefined();
    expect(contextOf(reading, { _tag: "ModelChanged", model: "claude-sonnet-5-5" })).toEqual({
      tokens: 5_000,
    });
  });

  it("reads as a count against the window, or the count alone", () => {
    expect(contextLabel({ tokens: 42_000, window: 200_000 })).toBe("42k of 200k · 21%");
    expect(contextLabel({ tokens: 42_000 })).toBe("42k in context");
    expect(contextFill({ tokens: 300_000, window: 200_000 })).toBe(1);
    expect(contextFill({ tokens: 3 })).toBeUndefined();
  });
});

describe("a compaction in the transcript", () => {
  it("is a line where the harness compacted mid-response", () => {
    const blocks = buildTranscript(
      events(
        input("t1"),
        { _tag: "ContextCompacted", trigger: "auto", tokensBefore: 180_000, tokensAfter: 20_000 },
        { _tag: "TurnCompleted", stopReason: "completed" },
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["user", "compacted", "turnEnd"]);
    expect(blocks[1]).toEqual({
      kind: "compacted",
      id: "compacted:e1",
      trigger: "auto",
      tokensBefore: 180_000,
      tokensAfter: 20_000,
    });
  });

  it("leaves a compaction the user asked for without a response footer or header of its own", () => {
    const blocks = buildTranscript(
      events(
        input("t1"),
        { _tag: "MessageCompleted", messageId: "m", text: "Done" },
        { _tag: "TurnCompleted", stopReason: "completed" },
        { _tag: "ContextCompacted", trigger: "manual", tokensBefore: 9_000, summary: "Kept" },
        { _tag: "TurnCompleted", stopReason: "completed" },
        input("t2"),
        { _tag: "TurnCompleted", stopReason: "completed" },
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "message",
      "turnEnd",
      "compacted",
      "user",
      "turnEnd",
    ]);
    expect(layout(blocks).map((item) => item.kind)).toEqual([
      "input",
      "header",
      "block",
      "turnEnd",
      "block",
      "input",
      "header",
      "turnEnd",
    ]);
  });

  it("leaves a refused compaction its error but no footer", () => {
    const blocks = buildTranscript(
      events(
        input("t1"),
        { _tag: "TurnCompleted", stopReason: "completed" },
        {
          _tag: "AgentError",
          kind: "unknown",
          message: "Couldn't compact the conversation: Nothing to compact.",
          retryable: false,
        },
        { _tag: "TurnCompleted", stopReason: "error" },
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["user", "turnEnd", "error"]);
  });
});
