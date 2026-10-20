import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { transcriptFixture } from "../src/dev/transcriptFixture.ts";
import { currentModel, layout } from "../src/features/transcript/layout.ts";
import { buildTranscript, queuedMessages } from "../src/features/transcript/model.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "a" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

describe("buildTranscript", () => {
  it("grows a streaming message from deltas until its completion replaces it", () => {
    const streaming = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "Hel" },
        { _tag: "MessageDelta", messageId: "m", text: "lo" },
      ),
    );
    expect(streaming).toEqual([{ kind: "message", id: "message:m", text: "Hello", streaming: true }]);

    const done = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "Hel" },
        { _tag: "MessageCompleted", messageId: "m", text: "Hello!" },
      ),
    );
    expect(done).toEqual([{ kind: "message", id: "message:m", text: "Hello!", streaming: false }]);
  });

  it("completes tool calls and attributes file changes to them", () => {
    const [tool] = buildTranscript(
      events(
        { _tag: "ToolCallStarted", callId: "c", toolName: "Edit", input: { file_path: "a.ts" } },
        { _tag: "ToolCallCompleted", callId: "c", output: "ok", isError: false },
        { _tag: "FileChanged", path: "a.ts", change: "modified" },
      ),
    );
    expect(tool).toMatchObject({ kind: "tool", status: "done", output: "ok", changedFiles: ["a.ts"] });
  });

  it("records how a permission request was resolved", () => {
    const [request] = buildTranscript(
      events(
        { _tag: "PermissionRequested", requestId: "c", toolName: "Bash", summary: "Run", input: {} },
        { _tag: "PermissionResolved", requestId: "c", decision: "deny", scope: "once" },
      ),
    );
    expect(request).toMatchObject({ kind: "permission", resolution: { decision: "deny", scope: "once" } });
  });

  it("keeps a question open until it closes, with what the user answered", () => {
    const questions = [
      {
        question: "Which?",
        options: [{ label: "This" }, { label: "That" }],
        multiSelect: false,
        allowOther: true,
      },
    ] as const;
    const asked = { _tag: "QuestionAsked", requestId: "q", questions } as const;
    expect(buildTranscript(events(asked))).toEqual([
      { kind: "question", id: "question:q", requestId: "q", questions },
    ]);
    const [answered] = buildTranscript(
      events(asked, {
        _tag: "QuestionResolved",
        requestId: "q",
        outcome: "answered",
        answers: [{ choices: ["That"] }],
      }),
    );
    expect(answered).toMatchObject({
      kind: "question",
      resolution: { outcome: "answered", answers: [{ choices: ["That"] }] },
    });
  });

  it("turns delivered inputs into user messages and notices, and closes turns with their usage", () => {
    const blocks = buildTranscript(transcriptFixture);
    const kinds = blocks.map((block) => block.kind);
    expect(kinds[0]).toBe("user");
    expect(kinds.filter((kind) => kind === "notice")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "spawn")).toHaveLength(2);
    expect(blocks.find((block) => block.kind === "turnEnd")).toMatchObject({
      usage: { inputTokens: 60_322, outputTokens: 1_390, costUsd: 0.142 },
    });
    expect(blocks.at(-1)).toMatchObject({ kind: "permission", toolName: "Bash" });
    expect(blocks.at(-1)).not.toHaveProperty("resolution");
  });
});

describe("queuedMessages", () => {
  const first = { _tag: "FromUser", id: "msg_1", text: "Fix the build" } as const;
  const second = { _tag: "FromUser", id: "msg_2", text: "And the tests" } as const;

  it("holds the user's messages until a turn delivers them, keeping their key", () => {
    const waiting = events({ _tag: "MessageQueued", message: first });
    expect(queuedMessages(waiting)).toEqual({
      messages: [{ kind: "user", id: "msg_1", text: "Fix the build", attachments: [], mentions: [] }],
      behindTurn: false,
    });
    expect(buildTranscript(waiting)).toEqual([]);

    const delivered = events(
      { _tag: "MessageQueued", message: first },
      { _tag: "TurnInput", items: [first] },
    );
    expect(queuedMessages(delivered).messages).toEqual([]);
    expect(buildTranscript(delivered)).toMatchObject([{ kind: "user", id: "msg_1" }]);
  });

  it("names the thread whose lead wrote a message for the user", () => {
    const brief = {
      ...first,
      writtenBy: { agentId: "lead" as AgentId, threadId: "home" as ThreadId, threadTitle: "Plan the week" },
    } as const;
    expect(buildTranscript(events({ _tag: "TurnInput", items: [brief] }))).toMatchObject([
      { kind: "user", id: "msg_1", writtenIn: "Plan the week" },
    ]);
  });

  it("knows when messages wait behind a running turn", () => {
    const midTurn = events(
      { _tag: "MessageQueued", message: first },
      { _tag: "TurnInput", items: [first] },
      { _tag: "MessageQueued", message: second },
    );
    expect(queuedMessages(midTurn)).toMatchObject({ messages: [{ id: "msg_2" }], behindTurn: true });

    const afterTurn = events(
      { _tag: "TurnInput", items: [first] },
      { _tag: "TurnCompleted", stopReason: "completed" },
      { _tag: "MessageQueued", message: second },
    );
    expect(queuedMessages(afterTurn).behindTurn).toBe(false);
  });
});

describe("the model each response ran on", () => {
  const started = {
    _tag: "SessionStarted",
    provider: "claude",
    providerSessionId: "s",
    model: "claude-opus-5-5",
    effort: "high",
  } as const;
  const say = (text: string): ReadonlyArray<EventPayload> => [
    { _tag: "TurnInput", items: [{ _tag: "FromUser", text }] },
    { _tag: "MessageCompleted", messageId: text, text: `Re: ${text}` },
    { _tag: "TurnCompleted", stopReason: "completed" },
  ];

  it("marks where a session starts and where the user switches model or effort, and skips no-ops", () => {
    const blocks = buildTranscript(
      events(
        started,
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "high" },
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "low" },
        { _tag: "ModelChanged", model: "claude-sonnet-5-5", effort: "low" },
      ),
    );
    expect(blocks).toMatchObject([
      { kind: "model", model: "claude-opus-5-5", effort: "high", change: "start" },
      { kind: "model", model: "claude-opus-5-5", effort: "low", change: "effort" },
      { kind: "model", model: "claude-sonnet-5-5", effort: "low", change: "model" },
    ]);
  });

  it("reads a switch by another id for the session's own model as an effort change", () => {
    const blocks = buildTranscript(
      events(started, { _tag: "ModelChanged", model: "opus", effort: "low" }),
      (a, b) => [a, b].every((id) => id === "opus" || id === "claude-opus-5-5"),
    );
    expect(blocks.at(-1)).toMatchObject({ kind: "model", model: "opus", effort: "low", change: "effort" });
  });

  it("labels each response with the model in effect when it began, not the thread's current one", () => {
    const blocks = buildTranscript(
      events(
        started,
        ...say("first"),
        { _tag: "ModelChanged", model: "claude-sonnet-5-5", effort: "medium" },
        ...say("second"),
      ),
    );
    const items = layout(blocks);
    expect(items.flatMap((item) => (item.kind === "header" ? [item.model] : []))).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    // The switch shows between the two responses, once.
    expect(items.map((item) => item.kind)).toEqual([
      "input",
      "header",
      "block",
      "turnEnd",
      "switch",
      "input",
      "header",
      "block",
      "turnEnd",
    ]);
    expect(currentModel(blocks)).toBe("claude-sonnet-5-5");
  });

  it("gives a response a header even when a switch sits between the message and its reply", () => {
    const items = layout(
      buildTranscript(
        events(
          started,
          { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "hi" }] },
          { _tag: "ModelChanged", model: "claude-haiku-5-5" },
          { _tag: "MessageCompleted", messageId: "m", text: "Hello" },
        ),
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["input", "switch", "header", "block"]);
  });

  it("leaves a response without a model when the thread never named one", () => {
    const items = layout(buildTranscript(events(...say("hi"))));
    expect(items[1]).toEqual({ kind: "header", id: expect.any(String) });
    expect(currentModel(buildTranscript(events(...say("hi"))))).toBeUndefined();
  });
});
