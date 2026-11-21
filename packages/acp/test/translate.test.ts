import { describe, expect, it } from "@effect/vitest";

import { AcpTranslator, record, string, usageReport } from "../src/index.ts";

const chunk = (kind: "agent_message_chunk" | "agent_thought_chunk", text: unknown) => ({
  sessionUpdate: kind,
  content: { type: "text", text },
});

describe("ACP translator", () => {
  it("keeps one message block across chunks and starts a new one when the kind changes", () => {
    const translator = new AcpTranslator({ provider: "devin" });
    const [thought] = translator.update(chunk("agent_thought_chunk", "Hmm"));
    expect(thought).toMatchObject({ _tag: "ReasoningDelta", text: "Hmm" });
    const switched = translator.update(chunk("agent_message_chunk", "Hi"));
    expect(switched.map(({ _tag }) => _tag)).toEqual(["ReasoningCompleted", "MessageDelta"]);
    const more = translator.update(chunk("agent_message_chunk", " there"));
    expect(more).toHaveLength(1);
    expect(more[0]).toMatchObject({ messageId: (switched[1] as { messageId: string }).messageId });
    // Empty or non-text content is no chunk at all.
    expect(translator.update(chunk("agent_message_chunk", ""))).toEqual([]);
    expect(translator.update({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })).toEqual(
      [],
    );
    expect(translator.finish(undefined, "m")).toEqual([
      expect.objectContaining({ _tag: "MessageCompleted", text: "Hi there" }),
    ]);
  });

  it("starts a tool once, reports diffs it showed while running, and ignores updates once it's done", () => {
    const translator = new AcpTranslator({ provider: "devin" });
    translator.update(chunk("agent_message_chunk", "Writing"));
    const started = translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      kind: "edit",
      title: "Edit files",
      rawInput: { path: "a" },
      content: [
        { type: "diff", path: "/a", oldText: "x", newText: "y" },
        { type: "diff", path: "/b", newText: "new" },
        { type: "diff", path: "/c", oldText: "old", newText: null },
      ],
    });
    expect(started).toEqual([
      expect.objectContaining({ _tag: "MessageCompleted", text: "Writing" }),
      { _tag: "ToolCallStarted", callId: "t", toolName: "edit", input: { path: "a" } },
    ]);
    expect(translator.call("t")).toEqual({ toolName: "edit", title: "Edit files", input: { path: "a" } });
    expect(
      translator.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" }),
    ).toEqual([]);
    expect(
      translator.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        rawOutput: "ok",
      }),
    ).toEqual([
      { _tag: "ToolCallCompleted", callId: "t", output: "ok", isError: false },
      { _tag: "FileChanged", path: "/a", change: "modified" },
      { _tag: "FileChanged", path: "/b", change: "created" },
      { _tag: "FileChanged", path: "/c", change: "deleted" },
    ]);
    expect(translator.call("t")).toBeUndefined();
    expect(
      translator.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" }),
    ).toEqual([]);
  });

  it("reports no file changes for a failed call, and fails calls the turn left running", () => {
    const translator = new AcpTranslator({ provider: "devin" });
    translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "f",
      content: [{ type: "diff", path: "/a", oldText: "x", newText: "y" }],
    });
    expect(
      translator.update({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "failed" }),
    ).toEqual([{ _tag: "ToolCallCompleted", callId: "f", output: null, isError: true }]);
    translator.update({ sessionUpdate: "tool_call", toolCallId: "open", title: "Searching" });
    expect(translator.finish({ stopReason: "cancelled" }, "m")).toEqual([
      { _tag: "ToolCallCompleted", callId: "open", output: null, isError: true },
    ]);
    // A new turn may reuse ids.
    expect(translator.update({ sessionUpdate: "tool_call", toolCallId: "f" })).toEqual([
      { _tag: "ToolCallStarted", callId: "f", toolName: "Tool", input: {} },
    ]);
  });

  it("translates plans, context usage and turn usage", () => {
    const translator = new AcpTranslator({ provider: "antigravity" });
    expect(
      translator.update({
        sessionUpdate: "plan",
        entries: [
          { content: "One", status: "completed" },
          { content: "Two", status: "in_progress" },
          { content: "Three", status: "pending" },
          { status: "completed" },
        ],
      }),
    ).toEqual([
      {
        _tag: "TodosUpdated",
        items: [
          { text: "One", status: "completed" },
          { text: "Two", status: "inProgress" },
          { text: "Three", status: "pending" },
        ],
      },
    ]);
    expect(translator.update({ sessionUpdate: "usage_update", used: 10, size: 0 })).toEqual([
      { _tag: "ContextReported", tokens: 10 },
    ]);
    expect(translator.update({ sessionUpdate: "usage_update", used: -1 })).toEqual([]);
    expect(translator.update({ sessionUpdate: "available_commands_update" })).toEqual([]);
    expect(translator.update("nonsense")).toEqual([]);
    expect(
      translator.finish({ usage: { inputTokens: 30, outputTokens: 4, cachedReadTokens: 2 } }, "m"),
    ).toEqual([
      {
        _tag: "UsageReported",
        provider: "antigravity",
        model: "m",
        inputTokens: 30,
        outputTokens: 4,
        cachedInputTokens: 2,
      },
    ]);
    expect(translator.finish({ usage: { inputTokens: 30 } }, "m")).toEqual([]);
  });

  it("takes a harness's tool names, inputs, outputs, failures and usage", () => {
    const translator = new AcpTranslator({
      provider: "grok",
      toolName: (call) => string(record(call["_meta"])?.["tool"]) ?? "unnamed",
      toolInput: (call) => call["rawInput"],
      toolOutput: (call) => call["rawOutput"],
      toolFailed: (call) => record(call["rawOutput"])?.["exit_code"] !== 0,
      usage: (result) =>
        usageReport({ provider: "grok", usage: record(result)?.["meta"], inputIncludesCache: true }),
    });
    expect(
      translator.update({ sessionUpdate: "tool_call", toolCallId: "x", _meta: { tool: "shell" } }),
    ).toEqual([{ _tag: "ToolCallStarted", callId: "x", toolName: "shell", input: undefined }]);
    expect(
      translator.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "x",
        status: "completed",
        rawOutput: { exit_code: 1 },
        content: [{ type: "diff", path: "/a", newText: "y" }],
      }),
    ).toEqual([{ _tag: "ToolCallCompleted", callId: "x", output: { exit_code: 1 }, isError: true }]);
    expect(
      translator.finish({ meta: { inputTokens: 100, outputTokens: 1, cachedReadTokens: 70 } }, "m"),
    ).toEqual([
      { _tag: "UsageReported", provider: "grok", inputTokens: 30, outputTokens: 1, cachedInputTokens: 70 },
    ]);
  });
});
