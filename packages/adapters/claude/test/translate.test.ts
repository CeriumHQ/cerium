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
    const tags = payloads
      .map((payload) => payload._tag)
      .filter((tag) => tag !== "MessageDelta" && tag !== "ContextReported");
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

  it("reports the context each request read and wrote, rising through the turn", () => {
    const readings = payloads.flatMap((payload) =>
      payload._tag === "ContextReported" ? [payload.tokens] : [],
    );
    expect(readings.length).toBeGreaterThan(1);
    expect(readings[0]).toBeGreaterThan(0);
    expect(readings).toEqual([...readings].sort((a, b) => a - b));
  });
});

describe("ClaudeTranslator on context and compaction", () => {
  const init = { type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5" };
  const request = (id: string, prompt: number, output: number) => [
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          id,
          usage: { input_tokens: 2, cache_creation_input_tokens: prompt - 2, cache_read_input_tokens: 0 },
        },
      },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: output } },
    },
  ];
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.01,
    usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
    modelUsage: { "claude-haiku-5-5": { contextWindow: 400_000 } },
  };
  /** Messages, and `measure` where the session takes Claude Code's own measure after a result. */
  const run = (messages: ReadonlyArray<object | { readonly measure: number | undefined }>) => {
    const translator = new ClaudeTranslator();
    return messages.flatMap((message) =>
      ("measure" in message
        ? translator.measured(
            message.measure === undefined ? undefined : { tokens: message.measure, window: 400_000 },
          )
        : translator.translate(message as SDKMessage)
      ).map((event) => event.payload),
    );
  };

  it("reports each request's prompt and output, with the window once Claude Code measured it", () => {
    const payloads = run([
      init,
      ...request("m1", 23_401, 10),
      result,
      { measure: 23_411 },
      ...request("m2", 23_500, 20),
    ]);
    expect(payloads.filter((payload) => payload._tag === "ContextReported")).toEqual([
      { _tag: "ContextReported", tokens: 23_411 },
      { _tag: "ContextReported", tokens: 23_411, window: 400_000 },
      { _tag: "ContextReported", tokens: 23_520, window: 400_000 },
    ]);
  });

  it("forgets the window when a turn runs on another model", () => {
    const payloads = run([
      init,
      { measure: 1_000 },
      { ...init, model: "claude-opus-5-5" },
      ...request("m1", 2_000, 10),
    ]);
    expect(payloads.at(-1)).toEqual({ _tag: "ContextReported", tokens: 2_010 });
  });

  it("reports a compaction with its counts and the summary Claude Code kept, not as a message", () => {
    const payloads = run([
      init,
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 23_411, post_tokens: 6_282 },
      },
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request: say hello.\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: C:\\t.jsonl Continue the conversation from where it left off without asking the user any further questions.",
        },
      },
      { ...result, usage: { ...result.usage, input_tokens: 0, output_tokens: 0 } },
      { measure: 19_870 },
    ]);
    // Claude Code's own count after (6,282) leaves out the system prompt and tools; its measure doesn't.
    expect(payloads.slice(1)).toEqual([
      { _tag: "UsageReported", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.01 },
      { _tag: "TurnCompleted", stopReason: "completed" },
      {
        _tag: "ContextCompacted",
        trigger: "manual",
        tokensBefore: 23_411,
        tokensAfter: 19_870,
        summary: "1. Primary Request: say hello.",
      },
      { _tag: "ContextReported", tokens: 19_870, window: 400_000 },
    ]);
  });

  it("sizes a compaction mid-turn by the prompt of the request after it", () => {
    const payloads = run([
      init,
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 180_000 },
      },
      ...request("m3", 9_000, 5),
    ]);
    expect(payloads.slice(1, 3)).toEqual([
      { _tag: "ContextCompacted", trigger: "auto", tokensBefore: 180_000, tokensAfter: 9_000 },
      { _tag: "ContextReported", tokens: 9_005 },
    ]);
  });

  it("reports a compaction without its size when Claude Code couldn't measure it", () => {
    const payloads = run([
      init,
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 5_000 },
      },
      result,
      { measure: undefined },
    ]);
    expect(payloads.at(-1)).toEqual({ _tag: "ContextCompacted", trigger: "manual", tokensBefore: 5_000 });
  });

  it("reports a compaction that failed as an error", () => {
    const [payload] = run([
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "Too short",
      },
    ]);
    expect(payload).toMatchObject({ _tag: "AgentError", message: expect.stringContaining("Too short") });
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
