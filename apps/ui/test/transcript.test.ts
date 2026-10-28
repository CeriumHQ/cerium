import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { transcriptFixture } from "../src/dev/transcriptFixture.ts";
import { currentModel, layout, pendingRouted } from "../src/features/transcript/layout.ts";
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

  it("places deltas by their offset, so text read mid-reply and deltas already held don't repeat", () => {
    const fence = "```artifact\n<style></style>\n```";
    const message = (text: string) => [{ kind: "message", id: "message:m", text, streaming: true }];
    // The window held the first delta, then read the thread: the text so far, then the next delta.
    const joined = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "```artifact\n", offset: 0 },
        { _tag: "MessageDelta", messageId: "m", text: "```artifact\n<style>", offset: 0 },
        { _tag: "MessageDelta", messageId: "m", text: "<style>", offset: 12 },
        { _tag: "MessageDelta", messageId: "m", text: "</style>\n```", offset: 19 },
      ),
    );
    expect(joined).toEqual(message(fence));

    // Deltas missed while the connection was down leave the text where it was until the read fills it.
    const gap = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "```artifact\n", offset: 0 },
        { _tag: "MessageDelta", messageId: "m", text: "</style>\n```", offset: 19 },
      ),
    );
    expect(gap).toEqual(message("```artifact\n"));

    // A machine too old to send offsets has its deltas appended.
    const older = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "Hel" },
        { _tag: "MessageDelta", messageId: "m", text: "lo" },
      ),
    );
    expect(older).toEqual(message("Hello"));
  });

  it("puts the files a turn changed on its footer, arriving after the next turn began, and their undo", () => {
    const changed: EventPayload = {
      _tag: "TurnFilesChanged",
      turnId: "t1",
      before: "s0",
      after: "s1",
      files: [{ path: "a.ts", change: "modified", added: 2, removed: 1, via: "edit" }],
    };
    const turn = (turnId: string): ReadonlyArray<EventPayload> => [
      { _tag: "TurnInput", items: [{ _tag: "FromUser", text: turnId }], turnId },
      { _tag: "TurnCompleted", stopReason: "completed" },
    ];
    const ends = (payloads: ReadonlyArray<EventPayload>) =>
      buildTranscript(events(...payloads)).flatMap((block) => (block.kind === "turnEnd" ? [block] : []));

    const [first, second] = ends([...turn("t1"), ...turn("t2"), changed]);
    expect(first?.changes).toEqual({
      turnId: "t1",
      before: "s0",
      after: "s1",
      files: [{ path: "a.ts", change: "modified", added: 2, removed: 1, via: "edit" }],
      more: 0,
    });
    expect(second?.changes).toBeUndefined();

    const undo = (direction: "undone" | "redone"): EventPayload => ({
      _tag: "TurnFilesReverted",
      turnId: "t1",
      direction,
      paths: [],
      kept: ["a.ts"],
    });
    expect(ends([...turn("t1"), changed, undo("undone")])[0]?.changes?.undone).toEqual({ kept: ["a.ts"] });
    expect(
      ends([...turn("t1"), changed, undo("undone"), undo("redone")])[0]?.changes?.undone,
    ).toBeUndefined();
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
      // Asked at the first event's time.
      { kind: "question", id: "question:q", requestId: "q", questions, at: 0 },
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
    expect(kinds.slice(0, 2)).toEqual(["model", "user"]);
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
      held: [],
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

  it("shows another thread's message as waiting until a turn delivers it, once", () => {
    const headsUp = {
      _tag: "FromAgent",
      id: "msg_3",
      agentId: "other" as AgentId,
      threadId: "elsewhere" as ThreadId,
      text: "I'm editing notes.md",
    } as const;
    const waiting = events({ _tag: "MessageHeld", message: headsUp });
    expect(queuedMessages(waiting).held).toEqual([
      { kind: "notice", id: "msg_3", item: headsUp, waiting: true },
    ]);
    expect(buildTranscript(waiting)).toEqual([]);

    const delivered = events(
      { _tag: "MessageHeld", message: headsUp },
      { _tag: "TurnInput", items: [headsUp, first] },
    );
    expect(queuedMessages(delivered).held).toEqual([]);
    expect(buildTranscript(delivered)).toMatchObject([
      { kind: "notice", item: { id: "msg_3" } },
      { kind: "user", id: "msg_1" },
    ]);
    expect(buildTranscript(delivered)[0]).not.toHaveProperty("waiting");
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

  it("marks a speed switch, and keeps the speed across a session that starts again", () => {
    const blocks = buildTranscript(
      events(
        started,
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "high", speed: "fast" },
        {
          _tag: "SessionStarted",
          provider: "claude",
          providerSessionId: "s-2",
          model: "claude-opus-5-5",
          effort: "high",
        },
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "high", speed: "fast" },
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "high", speed: "standard" },
      ),
    );
    expect(blocks.filter((block) => block.kind === "model" && block.change !== "start")).toMatchObject([
      { kind: "model", speed: "fast", change: "speed" },
      { kind: "model", speed: "standard", change: "speed" },
    ]);
  });

  it("puts the effort router's decision on its response's header, and runs on the level it picked", () => {
    const blocks = buildTranscript(
      events(
        started,
        { _tag: "EffortRouted", effort: "low", confidence: 0.8, ms: 400, costUsd: 0.00002 },
        ...say("rename it"),
        { _tag: "EffortRouted", effort: "low", kept: "unsure", confidence: 0.3 },
        ...say("again"),
        // Already on the routed level: no switch to show.
        { _tag: "ModelChanged", model: "claude-opus-5-5", effort: "low" },
        ...say("once more"),
      ),
    );
    const headers = layout(blocks).flatMap((item) => (item.kind === "header" ? [item.routed] : []));
    expect(headers).toEqual([
      { effort: "low", confidence: 0.8, ms: 400, costUsd: 0.00002 },
      { effort: "low", kept: "unsure", confidence: 0.3 },
      undefined,
    ]);
    expect(blocks.filter((block) => block.kind === "model")).toHaveLength(1);
  });

  it("shows the router's decision before the response starts, and inside one a child's result began", () => {
    const decided = buildTranscript(
      events(
        started,
        { _tag: "EffortRouted", effort: "high", confidence: 0.9 },
        {
          _tag: "TurnInput",
          items: [{ _tag: "FromUser", text: "plan it" }],
        },
      ),
    );
    expect(pendingRouted(decided)).toEqual({ effort: "high", confidence: 0.9 });

    const answered = buildTranscript(
      events(
        started,
        ...say("plan it"),
        { _tag: "EffortRouted", effort: "low", confidence: 0.7 },
        {
          _tag: "TurnInput",
          items: [{ _tag: "FromAgent", agentId: "c" as AgentId, threadId: "t" as ThreadId, text: "done" }],
        },
        { _tag: "TurnCompleted", stopReason: "completed" },
      ),
    );
    expect(pendingRouted(answered)).toBeUndefined();
    expect(layout(answered).filter((item) => item.kind === "routed")).toMatchObject([
      { decision: { effort: "low", confidence: 0.7 } },
    ]);
  });

  it("reads a switch by another id for the session's own model as an effort change", () => {
    const blocks = buildTranscript(
      events(started, { _tag: "ModelChanged", model: "opus", effort: "low" }),
      (a, b) => [a, b].every((id) => id === "opus" || id === "claude-opus-5-5"),
    );
    expect(blocks.at(-1)).toMatchObject({ kind: "model", model: "opus", effort: "low", change: "effort" });
  });

  it("marks a handoff to another harness, and labels each response with the harness it ran on", () => {
    const blocks = buildTranscript(
      events(
        started,
        ...say("first"),
        {
          _tag: "LeadHandedOff",
          from: { provider: "claude", model: "claude-opus-5-5" },
          provider: "codex",
          model: "gpt-6-luna",
          effort: "medium",
        },
        {
          _tag: "SessionStarted",
          provider: "codex",
          providerSessionId: "thread-1",
          model: "gpt-6-luna",
          effort: "medium",
        },
        ...say("second"),
      ),
    );
    const items = layout(blocks);
    expect(items.flatMap((item) => (item.kind === "header" ? [[item.provider, item.model]] : []))).toEqual([
      ["claude", "claude-opus-5-5"],
      ["codex", "gpt-6-luna"],
    ]);
    expect(items.filter((item) => item.kind === "switch")).toMatchObject([
      { provider: "codex", model: "gpt-6-luna", effort: "medium", change: "handoff" },
    ]);
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
