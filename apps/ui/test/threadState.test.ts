import {
  advanceThreadState,
  canAdvanceThreadState,
  emptyThreadState,
  type AgentEvent,
  type AgentInfo,
  type EventPayload,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { toAgentSummaries } from "../src/backend/view.ts";
import { queuedMessages } from "../src/features/transcript/model.ts";
import { runStats } from "../src/features/threads/runs.ts";

const agent = {
  id: "lead",
  threadId: "thread",
  role: "lead",
  provider: "codex",
  model: "initial",
  access: "ask",
  state: "running",
  createdAt: 0,
  updatedAt: 0,
} as AgentInfo;
const event = (sequence: number, payload: EventPayload): AgentEvent => ({
  id: `event-${sequence}` as AgentEvent["id"],
  threadId: agent.threadId,
  agentId: agent.id,
  sequence,
  at: sequence,
  payload,
});
const message = (id: string) => ({ _tag: "FromUser" as const, id, text: id });
const question = (id: string): EventPayload => ({
  _tag: "PermissionRequested",
  requestId: id,
  toolName: "test",
  summary: id,
  input: {},
});
const summary = (events: ReadonlyArray<AgentEvent>) => toAgentSummaries([agent], events, []);

describe("thread side state", () => {
  it("matches a full fold at every checkpoint while dropping settled conversation inputs", () => {
    const payloads: ReadonlyArray<EventPayload> = [
      { _tag: "MessageQueued", message: message("delivered") },
      { _tag: "TurnInput", items: [message("delivered")] },
      { _tag: "MessageQueued", message: message("next") },
      { _tag: "MessageQueued", message: message("withdrawn") },
      { _tag: "MessageWithdrawn", messageId: "withdrawn" },
      { _tag: "ContextReported", tokens: 30, window: 500 },
      { _tag: "UsageReported", inputTokens: 30, cachedInputTokens: 9, outputTokens: 2, costUsd: 0.01 },
      { _tag: "MessageCompleted", messageId: "first", text: "First reply" },
      question("answered"),
      { _tag: "PermissionResolved", requestId: "answered", decision: "allow", scope: "once" },
      question("pending"),
      { _tag: "TodosUpdated", items: [{ text: "test", status: "pending" }] },
      { _tag: "ContextCompacted", trigger: "manual", tokensAfter: 5, summary: "a compacted summary" },
      { _tag: "TurnCompleted", stopReason: "completed" },
      { _tag: "TurnInput", items: [message("next")] },
      { _tag: "ModelChanged", model: "new-model" },
      { _tag: "ContextReported", tokens: 4 },
      { _tag: "UsageReported", inputTokens: 4, outputTokens: 5 },
      { _tag: "MessageQueued", message: message("discarded") },
      { _tag: "ConversationRewound", fromSequence: 15, messageId: "next", via: "fork" },
      { _tag: "TurnInput", items: [message("replacement")] },
      { _tag: "MessageQueued", message: message("pending-a") },
      { _tag: "MessageQueued", message: message("pending-b") },
      { _tag: "MessageQueued", message: { ...message("pending-a"), text: "updated" } },
      { _tag: "MessageCompleted", messageId: "last", text: "Recent reply" },
    ];
    const history = payloads.map((payload, index) => event(index + 1, payload));
    let state = emptyThreadState();
    for (let index = 0; index < history.length; index++) {
      const next = history.slice(index, index + 1);
      expect(canAdvanceThreadState(state, next)).toBe(true);
      state = advanceThreadState(state, next);
      const prefix = history.slice(0, index + 1);
      expect(summary(state.events)).toEqual(summary(prefix));
      expect(queuedMessages(state.events)).toEqual(queuedMessages(prefix));
      expect(runStats(state.events, agent.id, 0)).toEqual(runStats(prefix, agent.id, 0));
    }
    expect(state.events.map(({ id }) => id)).not.toContain("event-8");
    expect(state.events.map(({ id }) => id)).not.toContain("event-9");
    expect(state.events.map(({ id }) => id)).not.toContain("event-19");
    expect(canAdvanceThreadState(state, [event(1, { _tag: "MessageQueued", message: message("old") })])).toBe(
      false,
    );
  });
});
