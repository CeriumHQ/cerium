import type { AgentEvent, EventPayload, ModelInfo } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";

import { failoverTarget, limitEpisode, openPause, pauseEnd } from "../src/limits.ts";

let sequence = 0;
const event = (payload: EventPayload): AgentEvent =>
  ({
    id: `evt_${sequence}`,
    threadId: "thr_1",
    agentId: "agt_1",
    sequence: sequence++,
    at: sequence,
    payload,
  }) as AgentEvent;

const paused = (resumeAt = 10) =>
  event({ _tag: "LimitPaused", provider: "claude", resumeAt, reported: true, attempt: 1 });

describe("pauseEnd", () => {
  const timing = { retry: 1_000, margin: 30 };

  it("waits for a reported reset, and a little past it", () => {
    assert.deepEqual(pauseEnd({ resetsAt: 5_000 }, 1_000, 0, timing), { resumeAt: 5_030, reported: true });
  });

  it("guesses when no reset is reported, longer with each pause in a row", () => {
    assert.deepEqual(pauseEnd({}, 1_000, 0, timing), { resumeAt: 2_000, reported: false });
    assert.deepEqual(pauseEnd({}, 1_000, 2, timing), { resumeAt: 4_000, reported: false });
  });

  it("treats a reset already past as none", () => {
    assert.deepEqual(pauseEnd({ resetsAt: 500 }, 1_000, 0, timing), { resumeAt: 2_000, reported: false });
  });
});

describe("limitEpisode", () => {
  it("collects the harnesses that ran out and the pauses since a turn last completed", () => {
    const episode = limitEpisode([
      event({ _tag: "LimitReached", provider: "codex", message: "old" }),
      event({ _tag: "TurnCompleted", stopReason: "completed" }),
      event({ _tag: "LimitReached", provider: "claude", message: "out" }),
      paused(),
      event({ _tag: "TurnCompleted", stopReason: "error" }),
      event({ _tag: "LimitReached", provider: "cursor", message: "out" }),
    ]);
    assert.deepEqual([...episode.providers].toSorted(), ["claude", "cursor"]);
    assert.strictEqual(episode.pauses, 1);
  });
});

describe("openPause", () => {
  it("is the latest pause nothing has ended", () => {
    const pause = paused(77);
    assert.strictEqual(
      openPause([event({ _tag: "LimitReached", provider: "claude", message: "" }), pause])?.resumeAt,
      77,
    );
  });

  it.each([
    ["a resume", event({ _tag: "LimitResumed", by: "reset" })],
    ["the user's message", event({ _tag: "MessageQueued", message: { _tag: "FromUser", text: "hi" } })],
    ["a new turn", event({ _tag: "TurnInput", items: [{ _tag: "FromUser", text: "hi" }] })],
    [
      "a handoff",
      event({
        _tag: "LeadHandedOff",
        from: { provider: "claude", model: "opus" },
        provider: "codex",
        model: "gpt-6-luna",
      }),
    ],
    ["a rewind", event({ _tag: "ConversationRewound", fromSequence: 0, messageId: "m", via: "fork" })],
  ])("ends with %s", (_name, ending) => {
    assert.isUndefined(openPause([paused(), ending]));
  });
});

describe("failoverTarget", () => {
  const model = (
    provider: ModelInfo["provider"],
    id: string,
    efforts: ModelInfo["efforts"] = [],
  ): ModelInfo => ({
    provider,
    id,
    label: id,
    efforts,
  });
  const offered = [
    model("claude", "opus", ["low", "high"]),
    model("codex", "gpt-6-luna", ["low", "medium", "high"]),
    model("cursor", "composer-2.5"),
  ];
  const roster = { models: [], edited: [] };
  const installed = () => true;

  it("takes the first roster model from a harness that hasn't run out, keeping the effort", () => {
    const target = failoverTarget(
      roster,
      offered,
      { provider: "claude", effort: "high" },
      new Set(["claude"]),
      installed,
    );
    assert.deepEqual(target, { provider: "codex", model: "gpt-6-luna", effort: "high" });
  });

  it("skips harnesses that ran out or aren't installed, and is none when none is left", () => {
    const next = failoverTarget(
      roster,
      offered,
      { provider: "claude" },
      new Set(["claude", "codex"]),
      installed,
    );
    assert.strictEqual(next?.provider, "cursor");
    assert.isUndefined(
      failoverTarget(
        roster,
        offered,
        { provider: "claude" },
        new Set(["claude", "codex", "cursor"]),
        installed,
      ),
    );
    assert.isUndefined(
      failoverTarget(
        roster,
        offered,
        { provider: "claude" },
        new Set(["claude"]),
        (provider) => provider === "claude",
      ),
    );
  });
});
