import type { AdapterEvent } from "@cerium/harness";
import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RecordedFrame } from "../src/session.ts";
import { MuseTranslator, type WireNotification } from "../src/translate.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (name: string): ReadonlyArray<RecordedFrame> =>
  readFileSync(join(fixtures, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RecordedFrame);

/** Replays recorded frames the way the session feeds them: submitted turns first, then their frames. */
const replay = (
  frames: ReadonlyArray<RecordedFrame>,
  translator = new MuseTranslator({ workspace: "<workspace>" }),
) =>
  frames.flatMap((frame): ReadonlyArray<AdapterEvent> => {
    if (!("cerium" in frame)) return translator.translate(frame);
    if (frame.cerium === "expectTurn") translator.expectTurn(frame.turnId);
    else translator.renameTurn(frame.from, frame.to);
    return [];
  });

const payloadsOf = (events: ReadonlyArray<AdapterEvent>) => events.map((event) => event.payload);

// Every recorded fixture: the echo one ships; `read-write-session.jsonl` appears once recorded on an account.
describe.each(readdirSync(fixtures).filter((name) => name.endsWith(".jsonl")))(
  "MuseTranslator on %s",
  (name) => {
    const frames = fixture(name);
    const events = replay(frames);
    const payloads = payloadsOf(events);
    const submitted = frames.filter((frame) => "cerium" in frame && frame.cerium === "expectTurn").length;

    it("emits only payloads that satisfy the canonical schema", () => {
      for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
    });

    it("keeps the raw notification on every event", () => {
      for (const event of events) expect(event.raw).toBeDefined();
    });

    it("ends every submitted turn exactly once, after its usage", () => {
      const tags = payloads.map((payload) => payload._tag);
      expect(tags.filter((tag) => tag === "TurnCompleted")).toHaveLength(submitted);
      const beforeEachEnd = tags.flatMap((tag, index) => (tag === "TurnCompleted" ? [tags[index - 1]] : []));
      expect(beforeEachEnd.every((tag) => tag === "UsageReported")).toBe(true);
    });

    it("streams each message under the id it completes with", () => {
      const completed = new Set(
        payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.messageId] : [])),
      );
      const streamed = payloads.flatMap((payload) =>
        payload._tag === "MessageDelta" ? [payload.messageId] : [],
      );
      expect(streamed.filter((messageId) => !completed.has(messageId))).toEqual([]);
    });

    it("pairs every tool call's start with its completion", () => {
      const started = payloads.flatMap((payload) =>
        payload._tag === "ToolCallStarted" ? [payload.callId] : [],
      );
      const ended = payloads.flatMap((payload) =>
        payload._tag === "ToolCallCompleted" ? [payload.callId] : [],
      );
      expect(ended.toSorted()).toEqual(started.toSorted());
    });
  },
);

describe("MuseTranslator on the recorded echo session", () => {
  const payloads = payloadsOf(replay(fixture("echo-session.jsonl")));

  it("produces each turn's reply in order", () => {
    expect(payloads.map((payload) => payload._tag)).toEqual([
      "MessageDelta",
      "MessageCompleted",
      "UsageReported",
      "TurnCompleted",
      "MessageDelta",
      "MessageCompleted",
      "UsageReported",
      "TurnCompleted",
    ]);
    expect(
      payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])),
    ).toEqual(["echo: hello echo", "echo: second turn"]);
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toEqual([
      { _tag: "TurnCompleted", stopReason: "completed" },
      { _tag: "TurnCompleted", stopReason: "completed" },
    ]);
  });
});

// Frames below are shaped like MSP 1.4's, with only the members the translator reads.
const SESSION = "s1";
const frame = (method: string, params: Record<string, unknown>): WireNotification => ({
  method,
  params: { sessionId: SESSION, ...params },
});
const item = (phase: "started" | "completed", fields: Record<string, unknown>) =>
  frame(`item/${phase}`, { item: fields });
const tokenUsage = (turnId: string, usage: Record<string, number>, promptTokens: number, costUsd?: number) =>
  frame("session/tokenUsage", {
    turnId,
    promptTokens,
    usage: { cachedTokens: 0, inputTokens: promptTokens, outputTokens: 0, reasoningTokens: 0, ...usage },
    cumulative: costUsd === undefined ? {} : { cost: { usd: costUsd } },
  });
const completed = (turnId: string, terminal: string, extra: Record<string, unknown> = {}) =>
  frame("turn/completed", { turnId, terminal, ...extra });

const translate = (translator: MuseTranslator, frames: ReadonlyArray<WireNotification>) =>
  payloadsOf(frames.flatMap((each) => translator.translate(each)));

describe("MuseTranslator tool calls and files", () => {
  const translator = new MuseTranslator({ workspace: "/work" });
  translator.expectTurn("t1");
  const payloads = translate(translator, [
    frame("turn/started", { turnId: "t1" }),
    // A delta that beats its item is held until the item names its kind.
    frame("item/delta", { itemId: "r1", field: "summary.0", delta: "Plan" }),
    item("started", { itemId: "r1", kind: "reasoning" }),
    frame("item/delta", { itemId: "r1", field: "summary.1", delta: "Write" }),
    item("completed", { itemId: "r1", kind: "reasoning", summary: ["Plan", "Write"] }),
    item("started", {
      itemId: "w1",
      kind: "toolCall",
      tool: "write_file",
      args: '{"path":"out.txt","content":"HI"}',
    }),
    item("completed", {
      itemId: "w1",
      kind: "toolCall",
      tool: "write_file",
      args: '{"path":"out.txt","content":"HI"}',
      status: "completed",
      visibleOutput: "wrote out.txt",
      patchSummary: { added: 1, removed: 0 },
    }),
    // Re-delivered completions add nothing.
    item("completed", { itemId: "w1", kind: "toolCall", tool: "write_file", status: "completed" }),
    item("completed", {
      itemId: "p1",
      kind: "toolCall",
      tool: "apply_patch",
      args: JSON.stringify({
        patch:
          "*** Begin Patch\n*** Add File: a.ts\n*** Delete File: /abs/b.ts\n*** Update File: c.ts\n*** End Patch",
      }),
      status: "completed",
    }),
    item("completed", {
      itemId: "x1",
      kind: "toolCall",
      tool: "shell",
      args: "not json",
      status: "failed",
      failureReason: "denied",
    }),
    item("started", { itemId: "m1", kind: "agentMessage" }),
    frame("item/delta", { itemId: "m1", delta: "HI" }),
    item("completed", { itemId: "m1", kind: "agentMessage", text: "HI" }),
    tokenUsage("t1", { cacheReadTokens: 30, outputTokens: 12 }, 100, 0.002),
    tokenUsage("t1", { cachedTokens: 50, outputTokens: 8 }, 70, 0.005),
    completed("t1", "completed"),
    // A turn Cerium did not submit (a cron job) never ends one the orchestrator waits on.
    completed("cron", "completed"),
  ]);

  it("streams reasoning parts and completes them joined", () => {
    expect(payloads.filter((payload) => payload._tag === "ReasoningDelta")).toEqual([
      { _tag: "ReasoningDelta", messageId: "r1", text: "Plan" },
      { _tag: "ReasoningDelta", messageId: "r1", text: "\n\nWrite" },
    ]);
    expect(payloads).toContainEqual({ _tag: "ReasoningCompleted", messageId: "r1", text: "Plan\n\nWrite" });
  });

  it("reports tool calls with their arguments and outcome", () => {
    expect(payloads).toContainEqual({
      _tag: "ToolCallStarted",
      callId: "w1",
      toolName: "write_file",
      input: { path: "out.txt", content: "HI" },
    });
    expect(
      payloads.filter((payload) => payload._tag === "ToolCallCompleted" && payload.callId === "w1"),
    ).toHaveLength(1);
    expect(payloads).toContainEqual({
      _tag: "ToolCallStarted",
      callId: "x1",
      toolName: "shell",
      input: "not json",
    });
    expect(payloads).toContainEqual({
      _tag: "ToolCallCompleted",
      callId: "x1",
      output: "denied",
      isError: true,
    });
  });

  it("reports the files built-in edit tools changed, resolved against the workspace", () => {
    const changes = payloads.flatMap((payload) => (payload._tag === "FileChanged" ? [payload] : []));
    expect(changes.map(({ path, change }) => [path.replaceAll("\\", "/"), change])).toEqual([
      ["/work/out.txt", "created"],
      ["/work/a.ts", "created"],
      ["/abs/b.ts", "deleted"],
      ["/work/c.ts", "modified"],
    ]);
  });

  it("sums the turn's model calls, keeping cache reads apart, and prices it by the session's estimate", () => {
    const usage = payloads.filter((payload) => payload._tag === "UsageReported");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 90, cachedInputTokens: 80, outputTokens: 20 });
    expect(usage[0]).toHaveProperty("costUsd");
    expect((usage[0] as { costUsd: number }).costUsd).toBeCloseTo(0.005);
  });

  it("ends only the turn Cerium submitted", () => {
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toEqual([
      { _tag: "TurnCompleted", stopReason: "completed" },
    ]);
    expect(translator.openTurns).toEqual([]);
  });
});

describe("MuseTranslator turn endings", () => {
  const endOf = (terminal: string, extra: Record<string, unknown> = {}) => {
    const translator = new MuseTranslator({ workspace: "/work" });
    translator.expectTurn("t");
    return translate(translator, [completed("t", terminal, extra)]);
  };

  it("maps terminals onto stop reasons", () => {
    expect(endOf("completed").at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
    expect(endOf("cancelled").at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
    expect(endOf("failed", { error: { kind: "stepLimit", message: "steps", retryable: false } })).toEqual([
      { _tag: "UsageReported", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      { _tag: "TurnCompleted", stopReason: "maxTurns" },
    ]);
  });

  it("asks for Muse's login when the account is signed out", () => {
    expect(
      endOf("failed", { error: { kind: "authRequired", message: "log in", retryable: false } })[0],
    ).toEqual({
      _tag: "AuthRequired",
      provider: "muse",
      reason: "log in",
      loginCommand: "muse login",
    });
  });

  it("reports quota failures as retryable rate limits", () => {
    expect(
      endOf("failed", { error: { kind: "modelError", message: "quota", retryable: false, quota: {} } })[0],
    ).toEqual({ _tag: "AgentError", kind: "rateLimit", message: "quota", retryable: true });
  });

  it("reports a host that died mid-turn as a crash", () => {
    expect(endOf("failed", { reason: "crash" })).toMatchObject([
      { _tag: "AgentError", kind: "crash", retryable: true },
      { _tag: "UsageReported" },
      { _tag: "TurnCompleted", stopReason: "error" },
    ]);
  });

  it("ends a reclaimed queued turn as interrupted, once", () => {
    const translator = new MuseTranslator({ workspace: "/work" });
    translator.expectTurn("q");
    const payloads = translate(translator, [
      frame("turn/unqueued", { turnId: "q" }),
      completed("q", "cancelled"),
    ]);
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toEqual([
      { _tag: "TurnCompleted", stopReason: "interrupted" },
    ]);
  });

  it("ends every open turn when the host goes away", () => {
    const translator = new MuseTranslator({ workspace: "/work" });
    translator.expectTurn("a");
    translator.expectTurn("b");
    const payloads = payloadsOf(translator.endOpenTurns("gone", {}));
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(2);
    expect(translator.endOpenTurns("again", {})).toEqual([]);
  });

  it("follows a turn the ack renamed", () => {
    const translator = new MuseTranslator({ workspace: "/work" });
    translator.expectTurn("command");
    translator.renameTurn("command", "turn");
    expect(translator.openTurns).toEqual([{ turnId: "turn", launched: false }]);
    expect(translate(translator, [completed("turn", "completed")]).at(-1)).toEqual({
      _tag: "TurnCompleted",
      stopReason: "completed",
    });
  });

  it("does not price a resumed session's first call against an unknown starting estimate", () => {
    const translator = new MuseTranslator({ workspace: "/work", resumed: true });
    translator.expectTurn("t");
    const usage = translate(translator, [tokenUsage("t", {}, 10, 1.5), completed("t", "completed")])[0];
    expect(usage).not.toHaveProperty("costUsd");
  });
});
