import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { limitName, limitOutcome, resumeTime } from "../src/features/transcript/limit.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "a" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

const reached = { _tag: "LimitReached", provider: "claude", window: "5-hour", message: "out" } as const;
const paused = {
  _tag: "LimitPaused",
  provider: "claude",
  window: "5-hour",
  resumeAt: 1_900_000_000_000,
  reported: true,
  attempt: 1,
} as const;

const limits = (...payloads: ReadonlyArray<EventPayload>) =>
  buildTranscript(events(...payloads)).filter((block) => block.kind === "limit");

describe("limit rows in the transcript", () => {
  it("shows the limit reached, and the pause it led to, as one row", () => {
    expect(limits(reached)).toMatchObject([{ state: "reached", provider: "claude", window: "5-hour" }]);
    expect(limits(reached, paused)).toMatchObject([
      { state: "paused", until: 1_900_000_000_000, reported: true },
    ]);
  });

  it("marks the same row resumed when the pause ends", () => {
    expect(limits(reached, paused, { _tag: "LimitResumed", by: "reset" })).toMatchObject([
      { state: "resumed", by: "reset" },
    ]);
  });

  it("keeps a limit reached with no pause as it is", () => {
    expect(limits(reached, { _tag: "TurnCompleted", stopReason: "error" })).toMatchObject([
      { state: "reached" },
    ]);
  });
});

describe("limit wording", () => {
  const [row] = limits(reached, paused);
  const [resumed] = limits(reached, paused, { _tag: "LimitResumed", by: "message" });

  it("names the harness and the limit", () => {
    expect(limitName({ provider: "claude", window: "5-hour" })).toBe("Claude 5-hour limit reached");
    expect(limitName({ provider: "codex" })).toBe("Codex usage limit reached");
  });

  it("says until when it waits, or when it tries again without a reported reset", () => {
    if (row?.kind !== "limit") throw new Error("expected a limit row");
    const now = 1_900_000_000_000 - 60_000;
    expect(limitOutcome(row, now)).toBe(`paused until ${resumeTime(row.until!, now)}`);
    expect(limitOutcome({ ...row, reported: false }, now)).toBe(
      `trying again at ${resumeTime(row.until!, now)}`,
    );
  });

  it("says what ended the pause", () => {
    if (resumed?.kind !== "limit") throw new Error("expected a limit row");
    expect(limitOutcome(resumed, 0)).toBe("went on with your message");
    expect(limitOutcome({ ...resumed, by: "reset" }, 0)).toBe("resumed");
  });

  it("leaves the day out for a time today, and adds it for another day", () => {
    const noon = new Date(2026, 9, 29, 12, 0).getTime();
    const evening = new Date(2026, 9, 29, 18, 30).getTime();
    const later = new Date(2026, 9, 31, 18, 30).getTime();
    expect(resumeTime(evening, noon)).not.toMatch(/[A-Za-z]{3}/u);
    expect(resumeTime(later, noon)).toMatch(/[A-Za-z]{3}/u);
  });
});
