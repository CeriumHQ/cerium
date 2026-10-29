import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { toolNamer } from "../src/policy.ts";
import { OpenCodeTranslator, type OpenCodeRecord } from "../src/translate.ts";

// `read-write-session.jsonl` is a real `opencode serve` 2.0.32 session on opencode/big-pickle, recorded
// by `scripts/record-fixture.ts`: a read, a write, a command and a call to the injected `smoke` MCP
// server with each approval answered once, then a turn interrupted at its first text. Every fixture in
// the folder is held to the contract tests.

const fixtures = join(import.meta.dirname, "fixtures");

const fixture = (name: string): ReadonlyArray<OpenCodeRecord> =>
  readFileSync(join(fixtures, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as OpenCodeRecord);

const translator = () => new OpenCodeTranslator({ toolName: toolNamer(["smoke", "cerium"]) });

const translateAll = (records: ReadonlyArray<OpenCodeRecord>, into = translator()) =>
  records.flatMap((record) => into.translate(record)).map((event) => event.payload);

/** A server event of the session `ses_1`, typed loosely as the fixtures are. */
const event = (type: string, data: object): OpenCodeRecord =>
  ({
    type: "event",
    event: { id: `evt_${type}`, type, data: { sessionID: "ses_1", ...data } },
  }) as unknown as OpenCodeRecord;

const opened: OpenCodeRecord = { type: "opened", sessionId: "ses_1", model: "opencode/big-pickle" };

describe.each(readdirSync(fixtures).filter((name) => name.endsWith(".jsonl")))(
  "OpenCodeTranslator on %s",
  (name) => {
    const records = fixture(name);
    const instance = translator();
    const events = records.flatMap((record) => instance.translate(record));
    const payloads = events.map((entry) => entry.payload);

    it("emits only payloads that satisfy the canonical schema", () => {
      for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
    });

    it("keeps the raw provider payload on every event", () => {
      for (const entry of events) expect(entry.raw).toBeDefined();
    });

    it("starts the session once, first", () => {
      expect(payloads[0]?._tag).toBe("SessionStarted");
      expect(payloads.filter((payload) => payload._tag === "SessionStarted")).toHaveLength(1);
    });

    it("completes exactly one turn per execution, last in each turn", () => {
      const ends = records.filter(
        (record) =>
          record.type === "event" &&
          record.event.type.startsWith("session.execution.") &&
          record.event.type !== "session.execution.started",
      );
      expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(ends.length);
      expect(payloads.at(-1)?._tag).toBe("TurnCompleted");
    });

    it("streams deltas under the id of the part they complete", () => {
      for (const [delta, done] of [
        ["MessageDelta", "MessageCompleted"],
        ["ReasoningDelta", "ReasoningCompleted"],
      ] as const) {
        const completed = payloads.flatMap((payload) => (payload._tag === done ? [payload] : []));
        // A part that never streamed (the server sent its text whole) has nothing to compare.
        const mismatched = completed.filter((part) => {
          const streamed = payloads.flatMap((payload) =>
            payload._tag === delta && payload.messageId === part.messageId ? [payload.text] : [],
          );
          return streamed.length > 0 && streamed.join("") !== part.text;
        });
        expect(mismatched).toEqual([]);
        expect(new Set(completed.map((part) => part.messageId)).size).toBe(completed.length);
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

    it("resolves every permission request it raised", () => {
      const asked = payloads.flatMap((payload) =>
        payload._tag === "PermissionRequested" ? [payload.requestId] : [],
      );
      const resolved = payloads.flatMap((payload) =>
        payload._tag === "PermissionResolved" ? [payload.requestId] : [],
      );
      expect(resolved.toSorted()).toEqual(asked.toSorted());
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

describe("OpenCodeTranslator on the recorded session", () => {
  const payloads = translateAll(fixture("read-write-session.jsonl"));
  const started = payloads.flatMap((payload) => (payload._tag === "ToolCallStarted" ? [payload] : []));
  const completion = (callId: string) =>
    payloads.find((payload) => payload._tag === "ToolCallCompleted" && payload.callId === callId);

  it("names MCP tools by server and built-ins as OpenCode does", () => {
    expect(started.map((payload) => payload.toolName)).toEqual(
      expect.arrayContaining(["read", "write", "shell", "mcp__smoke__echo"]),
    );
  });

  it("reports a command's output with its exit code", () => {
    const shell = started.find((payload) => payload.toolName === "shell")!;
    expect(completion(shell.callId)).toEqual({
      _tag: "ToolCallCompleted",
      callId: shell.callId,
      output: { output: "2\n", exitCode: 0 },
      isError: false,
    });
  });

  it("reports an MCP tool's text", () => {
    const echo = started.find((payload) => payload.toolName === "mcp__smoke__echo")!;
    expect(echo.input).toEqual({ text: "cerium" });
    expect(completion(echo.callId)).toMatchObject({ output: 'echo:"cerium"', isError: false });
  });

  it("reports the file the write created", () => {
    expect(payloads.filter((payload) => payload._tag === "FileChanged")).toEqual([
      { _tag: "FileChanged", path: "out.txt", change: "created" },
    ]);
  });

  it("shows an edit's approval as the patch it would apply", () => {
    const edit = payloads.find(
      (payload) => payload._tag === "PermissionRequested" && payload.toolName === "write",
    );
    expect(edit).toMatchObject({ summary: "Edit out.txt" });
    expect(edit?._tag === "PermissionRequested" && edit.input).toMatchObject({
      changes: [{ path: "out.txt", kind: { type: "add" } }],
    });
  });

  it("shows a command's approval as the command", () => {
    const command = payloads.find(
      (payload) => payload._tag === "PermissionRequested" && payload.toolName === "shell",
    );
    expect(command).toMatchObject({ summary: 'Run node -e "console.log(1 + 1)"' });
    expect(command?._tag === "PermissionRequested" && command.input).toMatchObject({
      command: 'node -e "console.log(1 + 1)"',
    });
  });

  it("ends the first turn completed and the interrupted one interrupted, without an error", () => {
    expect(
      payloads.flatMap((payload) => (payload._tag === "TurnCompleted" ? [payload.stopReason] : [])),
    ).toEqual(["completed", "interrupted"]);
    expect(payloads.filter((payload) => payload._tag === "AgentError")).toEqual([]);
  });

  it("replies with the uppercase text", () => {
    const replies = payloads.flatMap((payload) =>
      payload._tag === "MessageCompleted" ? [payload.text] : [],
    );
    expect(replies.join("\n")).toContain("HELLO FROM CERIUM");
  });
});

describe("OpenCodeTranslator", () => {
  it("keeps text and reasoning parts of one message apart", () => {
    const payloads = translateAll([
      opened,
      event("session.reasoning.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Thinking" }),
      event("session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Hi" }),
      event("session.reasoning.ended", { assistantMessageID: "msg_1", ordinal: 0, text: "Thinking" }),
      event("session.text.ended", { assistantMessageID: "msg_1", ordinal: 0, text: "Hi" }),
    ]);
    expect(payloads.slice(1)).toEqual([
      { _tag: "ReasoningDelta", messageId: "msg_1:reasoning:0", text: "Thinking" },
      { _tag: "MessageDelta", messageId: "msg_1:0", text: "Hi" },
      { _tag: "ReasoningCompleted", messageId: "msg_1:reasoning:0", text: "Thinking" },
      { _tag: "MessageCompleted", messageId: "msg_1:0", text: "Hi" },
    ]);
  });

  it("ends a turn by closing the parts, calls and requests it left open", () => {
    const payloads = translateAll([
      opened,
      event("session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Half" }),
      event("session.tool.input.started", { assistantMessageID: "msg_1", id: "call_1", name: "shell" }),
      event("session.tool.called", {
        assistantMessageID: "msg_1",
        id: "call_1",
        input: { command: "sleep 9" },
      }),
      event("permission.asked", {
        id: "per_1",
        action: "shell",
        resources: ["sleep 9"],
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      }),
      event("session.execution.interrupted", { reason: "user" }),
    ]);
    expect(payloads.slice(-4)).toEqual([
      { _tag: "MessageCompleted", messageId: "msg_1:0", text: "Half" },
      {
        _tag: "ToolCallCompleted",
        callId: "call_1",
        output: "The turn ended before this tool call finished.",
        isError: true,
      },
      { _tag: "PermissionResolved", requestId: "per_1", decision: "deny", scope: "once" },
      { _tag: "TurnCompleted", stopReason: "interrupted" },
    ]);
  });

  it("closes a request the server rejected on its own, and only once", () => {
    const instance = translator();
    translateAll(
      [
        opened,
        event("permission.asked", { id: "per_1", action: "edit", resources: ["a.txt"] }),
        event("permission.asked", { id: "per_2", action: "edit", resources: ["b.txt"] }),
      ],
      instance,
    );
    expect(
      instance.resolved("per_1", { decision: "deny", scope: "once" }).map((entry) => entry.payload),
    ).toEqual([{ _tag: "PermissionResolved", requestId: "per_1", decision: "deny", scope: "once" }]);
    // Rejecting one request rejects the session's others.
    const replied = translateAll(
      [
        event("permission.replied", { requestID: "per_1", reply: "reject" }),
        event("permission.replied", { requestID: "per_2", reply: "reject" }),
      ],
      instance,
    );
    expect(replied).toEqual([
      { _tag: "PermissionResolved", requestId: "per_2", decision: "deny", scope: "once" },
    ]);
  });

  it("sums a turn's steps into one usage, with reasoning as output and cache writes as input", () => {
    const step = (input: number, cost: number) =>
      event("session.step.ended", {
        assistantMessageID: "msg_1",
        finish: "stop",
        cost,
        tokens: { input, output: 10, reasoning: 5, cache: { read: 100, write: 20 } },
      });
    const payloads = translateAll([
      opened,
      step(1000, 0.01),
      step(50, 0.002),
      event("session.execution.succeeded", {}),
    ]);
    expect(payloads.slice(-2)).toEqual([
      { _tag: "UsageReported", inputTokens: 1090, outputTokens: 30, cachedInputTokens: 200, costUsd: 0.012 },
      { _tag: "TurnCompleted", stopReason: "completed" },
    ]);
  });

  it("leaves the cost out on free models", () => {
    const payloads = translateAll([
      opened,
      event("session.step.ended", {
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      event("session.execution.succeeded", {}),
    ]);
    expect(payloads.find((payload) => payload._tag === "UsageReported")).not.toHaveProperty("costUsd");
  });

  it("reports each step's context against the model's window, and a compaction with its summary", () => {
    const step = (input: number) =>
      event("session.step.ended", {
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input, output: 10, reasoning: 5, cache: { read: 100, write: 20 } },
      });
    const into = new OpenCodeTranslator({ window: () => 200_000 });
    const payloads = translateAll(
      [
        opened,
        step(1_000),
        event("session.execution.succeeded", {}),
        event("session.compaction.started", { reason: "manual", recent: "" }),
        event("session.compaction.ended", {
          reason: "manual",
          text: "## Objective\n- Say hello.\n",
          recent: "",
        }),
        event("session.execution.succeeded", {}),
        step(300),
      ],
      into,
    ).filter((payload) => payload._tag === "ContextReported" || payload._tag === "ContextCompacted");
    expect(payloads).toEqual([
      { _tag: "ContextReported", tokens: 1_135, window: 200_000 },
      {
        _tag: "ContextCompacted",
        trigger: "manual",
        tokensBefore: 1_135,
        summary: "## Objective\n- Say hello.",
      },
      { _tag: "ContextReported", tokens: 435, window: 200_000 },
    ]);
  });

  it("sizes a compaction mid-turn by what the step after it read", () => {
    const payloads = translateAll([
      opened,
      event("session.compaction.ended", { reason: "auto", text: "", recent: "" }),
      event("session.step.ended", {
        assistantMessageID: "msg_2",
        finish: "stop",
        cost: 0,
        tokens: { input: 900, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
      }),
    ]);
    expect(payloads.slice(1, 3)).toEqual([
      { _tag: "ContextCompacted", trigger: "auto", tokensAfter: 1_000 },
      { _tag: "ContextReported", tokens: 1_010 },
    ]);
  });

  it.each([
    [
      "provider.auth",
      { _tag: "AuthRequired", provider: "opencode", reason: "Bad key", loginCommand: "opencode auth login" },
    ],
    ["provider.rate-limit", { _tag: "AgentError", kind: "rateLimit", message: "Bad key", retryable: true }],
    ["provider.quota", { _tag: "LimitReached", provider: "opencode", message: "Bad key" }],
    ["provider.timeout", { _tag: "AgentError", kind: "transient", message: "Bad key", retryable: true }],
    ["provider.no-route", { _tag: "AgentError", kind: "unknown", message: "Bad key", retryable: false }],
  ])("reports a %s failure", (type, expected) => {
    const payloads = translateAll([
      opened,
      event("session.execution.failed", { error: { type, message: "Bad key" } }),
    ]);
    expect(payloads.slice(-2)).toEqual([expected, { _tag: "TurnCompleted", stopReason: "error" }]);
  });

  it.each(["aborted", "permission.rejected"])("ends a turn stopped by %s as interrupted", (type) => {
    const payloads = translateAll([
      opened,
      event("session.execution.failed", { error: { type, message: "Stopped" } }),
    ]);
    expect(payloads.slice(1)).toEqual([{ _tag: "TurnCompleted", stopReason: "interrupted" }]);
  });

  it("ends a turn whose prompt failed with the reason", () => {
    const payloads = translateAll([opened, { type: "promptFailed", message: "Session busy" }]);
    expect(payloads.slice(1)).toEqual([
      { _tag: "AgentError", kind: "unknown", message: "Session busy", retryable: false },
      { _tag: "TurnCompleted", stopReason: "error" },
    ]);
  });

  it("shows images a tool returned inline", () => {
    const payloads = translateAll([
      opened,
      event("session.tool.input.started", { assistantMessageID: "msg_1", id: "call_1", name: "read" }),
      event("session.tool.called", { assistantMessageID: "msg_1", id: "call_1", input: { path: "a.png" } }),
      event("session.tool.success", {
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [
          { type: "text", text: "Image read" },
          { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
        ],
      }),
    ]);
    expect(payloads.at(-1)).toEqual({
      _tag: "ToolCallCompleted",
      callId: "call_1",
      output: [
        { type: "text", text: "Image read" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
      isError: false,
    });
  });

  it("reports an edit's files from its metadata and a failed call's error", () => {
    const payloads = translateAll([
      opened,
      event("session.tool.input.started", { assistantMessageID: "msg_1", id: "call_1", name: "patch" }),
      event("session.tool.called", { assistantMessageID: "msg_1", id: "call_1", input: { patchText: "…" } }),
      event("session.tool.success", {
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "Applied" }],
        metadata: {
          files: [
            { file: "src/a.ts", status: "modified" },
            { file: "old.ts", status: "deleted" },
          ],
        },
      }),
      event("session.tool.input.started", { assistantMessageID: "msg_1", id: "call_2", name: "edit" }),
      event("session.tool.called", { assistantMessageID: "msg_1", id: "call_2", input: { path: "b.ts" } }),
      event("session.tool.failed", {
        assistantMessageID: "msg_1",
        id: "call_2",
        error: { type: "tool.execution", message: "oldString not found" },
      }),
    ]);
    expect(payloads.filter((payload) => payload._tag === "FileChanged")).toEqual([
      { _tag: "FileChanged", path: "src/a.ts", change: "modified" },
      { _tag: "FileChanged", path: "old.ts", change: "deleted" },
    ]);
    expect(payloads.at(-1)).toEqual({
      _tag: "ToolCallCompleted",
      callId: "call_2",
      output: "oldString not found",
      isError: true,
    });
  });
});
