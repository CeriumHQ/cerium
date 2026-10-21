import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { AgentEvent, answerText, CapabilityManifest } from "../src/index.ts";

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent);
const encodeEvent = Schema.encodeEffect(AgentEvent);

const envelope = {
  id: "evt_1",
  threadId: "thr_1",
  agentId: "agt_1",
  sequence: 0,
  at: 1_760_000_000_000,
};

describe("AgentEvent", () => {
  it.effect("decodes every payload kind and survives a JSON round trip", () =>
    Effect.gen(function* () {
      const payloads = [
        {
          _tag: "SessionStarted",
          provider: "claude",
          providerSessionId: "s1",
          model: "claude-opus-5-5",
          effort: "high",
        },
        { _tag: "MessageDelta", messageId: "m1", text: "Hel" },
        { _tag: "MessageCompleted", messageId: "m1", text: "Hello" },
        { _tag: "ReasoningDelta", messageId: "m1", text: "thinking" },
        { _tag: "ToolCallStarted", callId: "c1", toolName: "Read", input: { path: "a.ts" } },
        { _tag: "ToolCallCompleted", callId: "c1", output: "contents", isError: false },
        { _tag: "FileChanged", path: "a.ts", change: "modified" },
        { _tag: "PermissionRequested", requestId: "p1", toolName: "Bash", summary: "Run tests", input: {} },
        { _tag: "PermissionResolved", requestId: "p1", decision: "allow", scope: "once" },
        {
          _tag: "QuestionAsked",
          requestId: "q1",
          questions: [
            {
              header: "Library",
              question: "Which library should we use?",
              options: [{ label: "date-fns", description: "Small and tree-shakable" }, { label: "Luxon" }],
              multiSelect: false,
              allowOther: true,
            },
          ],
        },
        {
          _tag: "QuestionResolved",
          requestId: "q1",
          outcome: "answered",
          answers: [{ choices: ["Luxon"], text: "with the timezone plugin" }],
        },
        { _tag: "UsageReported", inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.01 },
        { _tag: "TurnCompleted", stopReason: "completed" },
        { _tag: "AuthRequired", provider: "codex", reason: "Not logged in", loginCommand: "codex login" },
        { _tag: "AgentError", kind: "rateLimit", message: "429", retryable: true },
        { _tag: "ReasoningCompleted", messageId: "m1", text: "because" },
        {
          _tag: "TurnInput",
          items: [
            { _tag: "FromUser", text: "hi" },
            { _tag: "ChildFinishedTurn", agentId: "agt_2", role: "reviewer", text: "LGTM" },
            { _tag: "FromAgent", agentId: "agt_3", threadId: "thr_2", text: "ping" },
            { _tag: "SystemNotice", text: "budget exceeded" },
          ],
        },
        {
          _tag: "AgentSpawned",
          childId: "agt_2",
          role: "reviewer",
          provider: "claude",
          model: "haiku",
          access: "readOnly",
        },
        { _tag: "AgentStateChanged", state: "idle" },
        { _tag: "SpawnApprovalRequested", requestId: "s1", role: "ci", provider: "codex", model: "gpt-6" },
        { _tag: "SpawnApprovalResolved", requestId: "s1", decision: "deny" },
      ];

      for (const payload of payloads) {
        const event = yield* decodeEvent({ ...envelope, payload, raw: { original: true } });
        assert.strictEqual(event.payload._tag, payload._tag);

        const encoded = yield* encodeEvent(event);
        const reparsed = yield* decodeEvent(JSON.parse(JSON.stringify(encoded)));
        assert.deepStrictEqual(reparsed, event);
      }
    }),
  );

  it.effect("rejects a turn input with no items", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeEvent({ ...envelope, payload: { _tag: "TurnInput", items: [] } }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects unknown payload kinds", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeEvent({ ...envelope, payload: { _tag: "Telepathy" } }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects negative and fractional sequence numbers", () =>
    Effect.gen(function* () {
      const payload = { _tag: "TurnCompleted", stopReason: "completed" };
      for (const sequence of [-1, 1.5]) {
        const exit = yield* Effect.exit(decodeEvent({ ...envelope, sequence, payload }));
        assert.isTrue(Exit.isFailure(exit));
      }
    }),
  );

  it.effect("reads a question's resolution of a kind this version doesn't know as expired", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent({
        ...envelope,
        payload: { _tag: "QuestionResolved", requestId: "q1", outcome: "postponed" },
      });
      assert.deepStrictEqual(event.payload, {
        _tag: "QuestionResolved",
        requestId: "q1",
        outcome: "expired",
      });
    }),
  );

  it.effect("rejects a question with nothing to ask", () =>
    Effect.gen(function* () {
      const asked = { _tag: "QuestionAsked", requestId: "q1" };
      const question = { question: "Which?", options: [], multiSelect: false, allowOther: true };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(decodeEvent({ ...envelope, payload: { ...asked, questions: [] } })),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeEvent({ ...envelope, payload: { ...asked, questions: [{ ...question, question: "" }] } }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isSuccess(
          yield* Effect.exit(decodeEvent({ ...envelope, payload: { ...asked, questions: [question] } })),
        ),
      );
    }),
  );

  it("writes an answer as one line, the picks first", () => {
    assert.strictEqual(answerText({ choices: ["A", "B"], text: " and more " }), "A, B, and more");
    assert.strictEqual(answerText({ choices: [], text: "just words" }), "just words");
    assert.strictEqual(answerText({ choices: ["A"], text: "  " }), "A");
  });

  it.effect("rejects empty identifiers", () =>
    Effect.gen(function* () {
      const payload = { _tag: "TurnCompleted", stopReason: "completed" };
      const exit = yield* Effect.exit(decodeEvent({ ...envelope, agentId: "", payload }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("CapabilityManifest", () => {
  const manifest = {
    provider: "claude",
    session: { resume: true, fork: true },
    switching: { model: true, effort: false, cacheSafeEffort: false },
    input: { images: true },
    permissions: { approvals: "callback", readOnlyMode: true },
    mcpInjection: true,
    nativeSubagents: "disableable",
    usageReporting: "tokensAndCost",
    defaultConcurrency: 6,
  };

  it.effect("decodes a complete manifest", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(CapabilityManifest)(manifest);
      assert.strictEqual(decoded.defaultConcurrency, 6);
    }),
  );

  it.effect("requires a concurrency cap of at least one", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(CapabilityManifest)({ ...manifest, defaultConcurrency: 0 }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
