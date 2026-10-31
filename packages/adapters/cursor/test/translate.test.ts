import { InteractionUpdateSchema } from "@cursor/sdk";
import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CursorTranslator, type CursorRecord } from "../src/translate.ts";

// `synthetic-session.jsonl` is SYNTHETIC: no logged-in Cursor account was available, so it was built
// from @cursor/sdk 1.0.38's `InteractionUpdate` and `RunResult` types (and is checked against the SDK's
// own update schema below), plus the run error a missing key produced live. Replace it by running
// `scripts/record-fixture.ts`, which writes `read-write-session.jsonl`; every fixture in the folder is
// held to the contract tests.

const fixtures = join(import.meta.dirname, "fixtures");

const fixture = (name: string): ReadonlyArray<CursorRecord> =>
  readFileSync(join(fixtures, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CursorRecord);

const translateAll = (records: ReadonlyArray<CursorRecord>) => {
  const translator = new CursorTranslator();
  return records.flatMap((record) => translator.translate(record));
};

const update = (turn: string, value: object): CursorRecord =>
  ({ type: "update", turn, update: value }) as unknown as CursorRecord;

const finished = (turn: string): CursorRecord =>
  ({ type: "result", turn, result: { id: "run-1", status: "finished" } }) as unknown as CursorRecord;

describe.each(readdirSync(fixtures).filter((name) => name.endsWith(".jsonl")))(
  "CursorTranslator on %s",
  (name) => {
    const records = fixture(name);
    const events = translateAll(records);
    const payloads = events.map((event) => event.payload);

    it("emits canonical payloads with their raw provider frames", () => {
      for (const event of events) {
        expect(Schema.is(EventPayload)(event.payload)).toBe(true);
        expect(event.raw).toBeDefined();
      }
    });

    it("starts the session once, first", () => {
      expect(payloads[0]?._tag).toBe("SessionStarted");
      expect(payloads.filter((payload) => payload._tag === "SessionStarted")).toHaveLength(1);
    });

    it("completes exactly one turn per send, last in each turn", () => {
      const ends = records.filter((record) => record.type === "result" || record.type === "sendFailed");
      expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(ends.length);
      expect(payloads.at(-1)?._tag).toBe("TurnCompleted");
    });

    it("streams deltas under the id of the segment they complete", () => {
      for (const [delta, done] of [
        ["MessageDelta", "MessageCompleted"],
        ["ReasoningDelta", "ReasoningCompleted"],
      ] as const) {
        const completed = payloads.flatMap((payload) => (payload._tag === done ? [payload] : []));
        for (const segment of completed) {
          const streamed = payloads.flatMap((payload) =>
            payload._tag === delta && payload.messageId === segment.messageId ? [payload.text] : [],
          );
          expect(streamed.join("")).toBe(segment.text);
        }
        expect(new Set(completed.map((segment) => segment.messageId)).size).toBe(completed.length);
      }
    });

    it("pairs every tool call start with one completion", () => {
      const started = payloads.flatMap((payload) =>
        payload._tag === "ToolCallStarted" ? [payload.callId] : [],
      );
      const completed = payloads.flatMap((payload) =>
        payload._tag === "ToolCallCompleted" ? [payload.callId] : [],
      );
      expect(completed.toSorted()).toEqual(started.toSorted());
      expect(new Set(started).size).toBe(started.length);
    });

    it("reports usage at most once per turn", () => {
      const perTurn: Array<number> = [];
      let usage = 0;
      for (const payload of payloads) {
        if (payload._tag === "UsageReported") usage++;
        if (payload._tag === "TurnCompleted") {
          perTurn.push(usage);
          usage = 0;
        }
      }
      expect(perTurn.filter((count) => count > 1)).toEqual([]);
    });
  },
);

describe("the synthetic fixture", () => {
  it("is shaped like the SDK's own updates", () => {
    const updates = fixture("synthetic-session.jsonl").flatMap((record) =>
      record.type === "update" ? [record.update] : [],
    );
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.filter((update) => !InteractionUpdateSchema.safeParse(update).success)).toEqual([]);
  });
});

describe("CursorTranslator on the synthetic session", () => {
  const payloads = translateAll(fixture("synthetic-session.jsonl")).map((event) => event.payload);

  it("reports the agent as the session to resume", () => {
    expect(payloads[0]).toEqual({
      _tag: "SessionStarted",
      provider: "cursor",
      providerSessionId: "agent-3f6b2c1e-8d4a-4c55-9a7e-2b1d0c9e8f71",
      model: "composer-2.5",
    });
  });

  it("names built-in tools as Cursor does and MCP tools by server", () => {
    const started = payloads.flatMap((payload) => (payload._tag === "ToolCallStarted" ? [payload] : []));
    expect(started.map((payload) => payload.toolName)).toEqual([
      "read",
      "edit",
      "mcp__cerium__list_agents",
      "shell",
    ]);
    expect(started[0]?.input).toEqual({ path: "<workspace>\\hello.txt" });
    expect(started[2]?.input).toEqual({});
  });

  it("reports the edited file", () => {
    expect(payloads.find((payload) => payload._tag === "FileChanged")).toEqual({
      _tag: "FileChanged",
      path: "<workspace>\\out.txt",
      change: "modified",
    });
  });

  it("cuts text into segments at tool calls and step ends", () => {
    const messages = payloads.flatMap((payload) =>
      payload._tag === "MessageCompleted" ? [payload.text] : [],
    );
    expect(messages).toEqual(["Reading the file.", "HELLO FROM CERIUM", "Waiting."]);
    const reasoning = payloads.find((payload) => payload._tag === "ReasoningCompleted");
    expect(reasoning).toMatchObject({ text: "Read hello.txt first, then write the uppercase copy." });
  });

  it("counts cache writes as input and reports cache reads separately", () => {
    expect(payloads.find((payload) => payload._tag === "UsageReported")).toEqual({
      _tag: "UsageReported",
      inputTokens: 1180 + 412,
      outputTokens: 86,
      cachedInputTokens: 29840,
    });
  });

  it("ends an interrupted turn, closing the command it cut off", () => {
    const shell = payloads.find(
      (payload) => payload._tag === "ToolCallStarted" && payload.toolName === "shell",
    );
    const closed = payloads.find(
      (payload) =>
        payload._tag === "ToolCallCompleted" &&
        shell?._tag === "ToolCallStarted" &&
        payload.callId === shell.callId,
    );
    expect(closed).toMatchObject({ isError: true });
    expect(
      payloads.filter((payload) => payload._tag === "TurnCompleted").map((payload) => payload.stopReason),
    ).toEqual(["completed", "interrupted", "error", "error"]);
  });

  it("asks for the SDK's sign-in when the key is rejected", () => {
    expect(payloads.find((payload) => payload._tag === "AuthRequired")).toEqual({
      _tag: "AuthRequired",
      provider: "cursor",
      reason: "[unknown] Invalid User API Key",
    });
  });

  it("reports a send that ran out of usage as a limit, apart from a failure", () => {
    expect(payloads.find((payload) => payload._tag === "LimitReached")).toEqual({
      _tag: "LimitReached",
      provider: "cursor",
      message: "Usage limit exceeded",
    });
  });
});

describe("CursorTranslator edge cases", () => {
  const completedCall = (toolCall: object) =>
    new CursorTranslator()
      .translate(update("t", { type: "tool-call-completed", callId: "c1", toolCall, modelCallId: "m" }))
      .map((event) => event.payload);

  it("marks a command that exited non-zero as failed", () => {
    const payloads = completedCall({
      type: "shell",
      args: { command: "exit 1" },
      result: {
        status: "success",
        value: { exitCode: 1, signal: "", stdout: "", stderr: "boom", executionTime: 3 },
      },
    });
    expect(payloads.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({ isError: true });
  });

  it("marks an MCP tool error as failed", () => {
    const payloads = completedCall({
      type: "mcp",
      args: { providerIdentifier: "cerium", toolName: "spawn_agent", args: { role: "x" } },
      result: { status: "success", value: { content: [{ text: { text: "denied" } }], isError: true } },
    });
    expect(payloads.map((payload) => payload._tag)).toEqual(["ToolCallStarted", "ToolCallCompleted"]);
    expect(payloads[0]).toMatchObject({ toolName: "mcp__cerium__spawn_agent", input: { role: "x" } });
    expect(payloads[1]).toMatchObject({ isError: true });
  });

  it("reports deletions and ignores failed edits", () => {
    const deleted = completedCall({
      type: "delete",
      args: { path: "a.txt" },
      result: { status: "success", value: { fileSize: 3 } },
    });
    expect(deleted.at(-1)).toEqual({ _tag: "FileChanged", path: "a.txt", change: "deleted" });
    const failed = completedCall({
      type: "edit",
      args: { path: "b.txt" },
      result: { status: "error", error: { message: "no match" } },
    });
    expect(failed.some((payload) => payload._tag === "FileChanged")).toBe(false);
    expect(failed.at(-1)).toMatchObject({
      _tag: "ToolCallCompleted",
      isError: true,
      output: { message: "no match" },
    });
  });

  it("gives text after reasoning in the same step its own segment", () => {
    const translator = new CursorTranslator();
    const payloads = [
      update("t", { type: "thinking-delta", text: "hmm" }),
      update("t", { type: "text-delta", text: "answer" }),
      finished("t"),
    ].flatMap((record) => translator.translate(record).map((event) => event.payload));
    expect(payloads).toEqual([
      { _tag: "ReasoningDelta", messageId: "t:0", text: "hmm" },
      { _tag: "ReasoningCompleted", messageId: "t:0", text: "hmm" },
      { _tag: "MessageDelta", messageId: "t:1", text: "answer" },
      { _tag: "MessageCompleted", messageId: "t:1", text: "answer" },
      { _tag: "TurnCompleted", stopReason: "completed" },
    ]);
  });

  it("falls back to the run's usage and sums several model turns", () => {
    const fromRun = new CursorTranslator().translate({
      type: "result",
      turn: "t",
      result: {
        id: "run-1",
        status: "finished",
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 8 },
      },
    });
    expect(fromRun[0]?.payload).toEqual({
      _tag: "UsageReported",
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 1,
    });

    const translator = new CursorTranslator();
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 2 };
    const summed = [
      update("t", { type: "turn-ended", usage }),
      update("t", { type: "turn-ended", usage }),
      finished("t"),
    ]
      .flatMap((record) => translator.translate(record))
      .map((event) => event.payload)
      .find((payload) => payload._tag === "UsageReported");
    expect(summed).toEqual({
      _tag: "UsageReported",
      inputTokens: 24,
      outputTokens: 2,
      cachedInputTokens: 200,
    });
  });

  it("completes a turn the model ended while its run kept going", () => {
    const translator = new CursorTranslator();
    const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 };
    const payloads = [
      update("t", { type: "text-delta", text: "DONE" }),
      update("t", { type: "turn-ended", usage }),
      { type: "turnEnded", turn: "t" } satisfies CursorRecord,
    ]
      .flatMap((record) => translator.translate(record))
      .map((event) => event.payload);
    expect(payloads.map((payload) => payload._tag)).toEqual([
      "MessageDelta",
      "MessageCompleted",
      "UsageReported",
      "TurnCompleted",
    ]);
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
  });

  it("maps a thrown authentication error to AuthRequired", () => {
    const [first] = new CursorTranslator().translate({
      type: "sendFailed",
      turn: "t",
      error: { message: "Invalid API key.", kind: "auth", code: "unauthenticated" },
    });
    expect(first?.payload).toMatchObject({ _tag: "AuthRequired", provider: "cursor" });
  });

  it("keeps unknown tool kinds under their raw name", () => {
    const payloads = completedCall({ case: "futureToolCall", value: { x: 1 } });
    expect(payloads[0]).toMatchObject({
      _tag: "ToolCallStarted",
      toolName: "futureToolCall",
      input: { x: 1 },
    });
  });
});
