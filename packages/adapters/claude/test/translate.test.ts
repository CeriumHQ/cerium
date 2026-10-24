import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ClaudeTranslator } from "../src/translate.ts";

const fixture = (name: string): ReadonlyArray<SDKMessage> =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage | { type: "cerium_permission_request" })
    // Permission requests arrive through canUseTool, not the message stream.
    .filter((message): message is SDKMessage => message.type !== "cerium_permission_request");

const translateAll = (messages: ReadonlyArray<SDKMessage>) => {
  const translator = new ClaudeTranslator();
  return messages.flatMap((message) => translator.translate(message));
};

describe("ClaudeTranslator on a recorded read/write session", () => {
  const events = translateAll(fixture("read-write-session.jsonl"));
  const payloads = events.map((event) => event.payload);

  it.each(["read-write-session.jsonl", "todo-session.jsonl", "todo-write-session.jsonl"])(
    "emits only payloads that satisfy the canonical schema from %s",
    (name) => {
      for (const event of translateAll(fixture(name))) {
        expect(Schema.is(EventPayload)(event.payload)).toBe(true);
      }
    },
  );

  it("keeps the raw provider message on every event", () => {
    for (const event of events) expect(event.raw).toBeDefined();
  });

  it("produces the session lifecycle in order", () => {
    const tags = payloads.map((payload) => payload._tag).filter((tag) => tag !== "MessageDelta");
    expect(tags).toEqual([
      "SessionStarted",
      "ToolCallStarted",
      "ToolCallCompleted",
      "ToolCallStarted",
      "ToolCallCompleted",
      "FileChanged",
      "MessageCompleted",
      "UsageReported",
      "TurnCompleted",
    ]);
  });

  it("reports the session and the tools it used", () => {
    expect(payloads[0]).toMatchObject({
      _tag: "SessionStarted",
      provider: "claude",
      model: "claude-haiku-5-5",
    });
    const tools = payloads.flatMap((payload) =>
      payload._tag === "ToolCallStarted" ? [payload.toolName] : [],
    );
    expect(tools).toEqual(["Read", "Write"]);
  });

  it("reports the created file", () => {
    const change = payloads.find((payload) => payload._tag === "FileChanged");
    expect(change).toMatchObject({ change: "created", path: "<workspace>\\out.txt" });
  });

  it("streams text deltas under the same id as the completed message", () => {
    const completed = payloads.find((payload) => payload._tag === "MessageCompleted");
    const deltas = payloads.filter((payload) => payload._tag === "MessageDelta");
    expect(completed?._tag === "MessageCompleted" && completed.text).toBe("HELLO FROM CERIUM");
    expect(deltas.map((delta) => delta.text).join("")).toBe("HELLO FROM CERIUM");
    for (const delta of deltas) {
      expect(delta.messageId).toBe(completed?._tag === "MessageCompleted" ? completed.messageId : undefined);
    }
  });

  it("skips empty thinking deltas", () => {
    expect(payloads.some((payload) => payload._tag === "ReasoningDelta")).toBe(false);
  });

  it("reports usage with cache reads separated and a completed turn", () => {
    const usage = payloads.find((payload) => payload._tag === "UsageReported");
    const positive = expect.toSatisfy((value: number) => value > 0);
    expect(usage).toMatchObject({ _tag: "UsageReported", cachedInputTokens: positive, costUsd: positive });
    expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
  });
});

describe("ClaudeTranslator edge cases", () => {
  it("maps authentication failures to AuthRequired with the CLI login command", () => {
    const [event] = new ClaudeTranslator().translate({
      type: "assistant",
      error: "authentication_failed",
      parent_tool_use_id: null,
      message: { id: "msg_1", content: [] },
    } as unknown as SDKMessage);
    expect(event?.payload).toEqual({
      _tag: "AuthRequired",
      provider: "claude",
      reason: "authentication_failed",
      loginCommand: "claude auth login",
    });
  });

  it("maps rejected rate limits to a retryable error", () => {
    const [event] = new ClaudeTranslator().translate({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    } as unknown as SDKMessage);
    expect(event?.payload).toMatchObject({ _tag: "AgentError", kind: "rateLimit", retryable: true });
  });

  it("starts the session once although Claude Code repeats init every turn", () => {
    const translator = new ClaudeTranslator();
    const init = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-haiku-5-5",
    } as unknown as SDKMessage;
    expect([...translator.translate(init), ...translator.translate(init)]).toHaveLength(1);
  });

  it("reports per-turn cost from the session's cumulative total", () => {
    const translator = new ClaudeTranslator();
    const result = (totalCostUsd: number) =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
        total_cost_usd: totalCostUsd,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      }) as unknown as SDKMessage;
    const costs = [result(0.25), result(0.3)].flatMap((message) =>
      translator
        .translate(message)
        .flatMap((event) => (event.payload._tag === "UsageReported" ? [event.payload.costUsd] : [])),
    );
    expect(costs[0]).toBeCloseTo(0.25);
    expect(costs[1]).toBeCloseTo(0.05);
  });

  it("ends a turn interrupted during a tool call as interrupted, not as an error", () => {
    const [, completed] = new ClaudeTranslator().translate({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    } as unknown as SDKMessage);
    expect(completed?.payload).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
  });

  it("pairs streamed reasoning with its completed thinking block", () => {
    const translator = new ClaudeTranslator();
    const stream = (event: object) =>
      ({ type: "stream_event", parent_tool_use_id: null, event }) as unknown as SDKMessage;
    const payloads = [
      stream({ type: "message_start", message: { id: "msg_3" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_3", content: [{ type: "thinking", thinking: "hmm" }] },
      } as unknown as SDKMessage,
    ].flatMap((message) => translator.translate(message).map((event) => event.payload));
    expect(payloads).toEqual([
      { _tag: "ReasoningDelta", messageId: "msg_3:0", text: "hmm" },
      { _tag: "ReasoningCompleted", messageId: "msg_3:0", text: "hmm" },
    ]);
  });

  it("pairs a message's later text block with its stream after the earlier one completed", () => {
    const translator = new ClaudeTranslator();
    const stream = (event: object) =>
      ({ type: "stream_event", parent_tool_use_id: null, event }) as unknown as SDKMessage;
    const text = (index: number, delta: string) => [
      stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: delta } }),
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_4", content: [{ type: "text", text: delta }] },
      } as unknown as SDKMessage,
    ];
    const ids = [
      stream({ type: "message_start", message: { id: "msg_4" } }),
      ...text(0, "a"),
      ...text(2, "b"),
    ]
      .flatMap((message) => translator.translate(message))
      .map((event) => [
        event.payload._tag,
        "messageId" in event.payload ? event.payload.messageId : undefined,
      ]);
    expect(ids).toEqual([
      ["MessageDelta", "msg_4:0"],
      ["MessageCompleted", "msg_4:0"],
      ["MessageDelta", "msg_4:2"],
      ["MessageCompleted", "msg_4:2"],
    ]);
  });

  it("numbers completed text blocks when partial messages are off", () => {
    const translator = new ClaudeTranslator();
    const block = (text: string) =>
      ({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_2", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage;
    const ids = [...translator.translate(block("a")), ...translator.translate(block("b"))].map((event) =>
      event.payload._tag === "MessageCompleted" ? event.payload.messageId : undefined,
    );
    expect(ids).toEqual(["msg_2:t0", "msg_2:t1"]);
  });
});
