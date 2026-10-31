import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AgyTranslator, errorPayload, stderrError, type AgyEvent, type AgyRecord } from "../src/translate.ts";

// The fixtures are a run's stream lines:
// - `prior-art-a4amk.jsonl` is the sample stream a4amk/agy-agent-mcp tests against (test/client6.ts),
//   modelled on real output: PascalCase arguments, a tool step that arrives DONE only, soft-denied
//   actions.
// - `signed-out-result-1.4.12.jsonl` is what Antigravity CLI 1.4.12 printed live, signed out.
// `scripts/record-fixture.ts` records a signed-in run beside them.

const fixtures = join(import.meta.dirname, "fixtures");
const lines = (name: string) =>
  readFileSync(join(fixtures, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AgyEvent);

const translate = (events: ReadonlyArray<AgyEvent>, records: ReadonlyArray<AgyRecord> = []) => {
  const translator = new AgyTranslator({ mcpServers: ["cerium"], plugin: "cerium", cwd: "/work/demo" });
  return [
    { type: "opened", model: "gemini-3.8-flash" } as const,
    { type: "run" } as const,
    ...events.map((event) => ({ type: "event", event }) as const),
    ...records,
  ]
    .flatMap((record) => translator.translate(record))
    .map((event) => event.payload);
};

describe.each(readdirSync(fixtures).filter((name) => name.endsWith(".jsonl")))(
  "the contract on %s",
  (name) => {
    const payloads = translate(lines(name), [{ type: "exited", code: 0 }]);

    it("emits only canonical payloads and ends the run's turn once", () => {
      for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
      expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(1);
      expect(payloads.at(-1)?._tag).toBe("TurnCompleted");
    });

    it("pairs every tool start with one end", () => {
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

describe("a run from a4amk's sample stream", () => {
  const payloads = translate(lines("prior-art-a4amk.jsonl"));

  it("starts the session from the conversation id at the top of init", () => {
    expect(payloads[0]).toEqual({
      _tag: "SessionStarted",
      provider: "antigravity",
      providerSessionId: "6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10",
      model: "gemini-3.8-flash",
    });
  });

  it("names native tools as the transcript knows them, with their PascalCase arguments readable", () => {
    const started = payloads.flatMap((payload) => (payload._tag === "ToolCallStarted" ? [payload] : []));
    expect(started.map((call) => call.toolName)).toEqual(["write", "read", "shell"]);
    expect(started[0]!.input).toMatchObject({ path: "/tmp/opencode/agy-tmux-test/probe.txt" });
    expect(started[2]!.input).toMatchObject({ command: "git status" });
  });

  it("joins streamed text into one message and reports the written file", () => {
    expect(
      payloads.filter((payload) => payload._tag === "MessageCompleted").map((payload) => payload.text),
    ).toEqual(["Hello streamed world!"]);
    expect(payloads.filter((payload) => payload._tag === "FileChanged")).toEqual([
      { _tag: "FileChanged", path: "/tmp/opencode/agy-tmux-test/probe.txt", change: "created" },
    ]);
  });

  it("reports the run's usage, the context it read, and what Antigravity's own rules denied", () => {
    expect(payloads.find((payload) => payload._tag === "UsageReported")).toEqual({
      _tag: "UsageReported",
      inputTokens: 7993,
      outputTokens: 14,
    });
    expect(payloads.filter((payload) => payload._tag === "ContextReported").at(-1)).toEqual({
      _tag: "ContextReported",
      tokens: 7993,
    });
    expect(payloads.find((payload) => payload._tag === "AgentError")).toMatchObject({
      message: "Antigravity's own permission rules denied: RunCommand.",
    });
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
  });
});

describe("a signed-out run (live, 1.4.12)", () => {
  it("asks for a sign-in and fails the turn", () => {
    const payloads = translate(lines("signed-out-result-1.4.12.jsonl"));
    expect(payloads.some((payload) => payload._tag === "SessionStarted")).toBe(false);
    expect(payloads.find((payload) => payload._tag === "AuthRequired")).toEqual({
      _tag: "AuthRequired",
      provider: "antigravity",
      reason: "authentication failed or timed out",
      loginCommand: "agy",
    });
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "error" });
  });
});

describe("runs that end early", () => {
  it("reads an interrupted result as interrupted, closing what was open", () => {
    const payloads = translate([
      {
        event: "step_update",
        step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Count" },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "sleep 9" } },
        },
      },
      { event: "result", result: { status: "CANCELED", finished_reason: "interrupted" } },
    ]);
    expect(payloads.filter((payload) => payload._tag === "ToolCallCompleted")).toMatchObject([
      { isError: true },
    ]);
    expect(payloads.find((payload) => payload._tag === "MessageCompleted")).toMatchObject({ text: "Count" });
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
  });

  it("ends a run that exited without its result, in its own words", () => {
    const payloads = translate(
      [],
      [{ type: "exited", code: 3, stderr: 'AGY_ERROR: {"message":"model unavailable (503)"}' }],
    );
    expect(payloads.slice(-2)).toEqual([
      { _tag: "AgentError", kind: "transient", message: "model unavailable (503)", retryable: true },
      { _tag: "TurnCompleted", stopReason: "error" },
    ]);
  });
});

describe("errors", () => {
  it("reads stderr's structured and plain errors", () => {
    expect(stderrError("noise\nerror: authentication failed or timed out\n")).toBe(
      "authentication failed or timed out",
    );
    expect(stderrError('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED"}')).toBe("RESOURCE_EXHAUSTED");
  });

  it("tells a plan limit, a throttle and a sign-in apart", () => {
    expect(errorPayload("API error: RESOURCE_EXHAUSTED (code 429): quota. Resets in 7m11s.")).toMatchObject({
      _tag: "LimitReached",
      provider: "antigravity",
    });
    expect(errorPayload("rate limit, try again")).toMatchObject({ _tag: "AgentError", kind: "rateLimit" });
    expect(errorPayload("Authentication expired. Please log back in.")).toMatchObject({
      _tag: "AuthRequired",
    });
  });
});
