import {
  AccessMode,
  AgentEvent,
  AgentId,
  AgentInfo,
  HarnessStatus,
  ProviderId,
  ReasoningEffort,
  ThreadId,
  ThreadInfo,
  ThreadMode,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// The contract between the UI and the backend, served over a localhost WebSocket
// (docs/architecture.md §7). Payloads and results are protocol schemas, so both sides validate them.

/** A request the backend refused; `message` is written for the user. */
export class CeriumError extends Schema.TaggedError<CeriumError>()("CeriumError", {
  message: Schema.String,
}) {}

/** What the sidebar needs about one thread. */
export const ThreadOverview = Schema.Struct({
  thread: ThreadInfo,
  agents: Schema.Array(AgentInfo),
  awaitingApproval: Schema.Boolean,
});
export type ThreadOverview = typeof ThreadOverview.Type;

export const CreateThreadPayload = Schema.Struct({
  title: Schema.String,
  mode: ThreadMode,
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  lead: Schema.Struct({
    provider: ProviderId,
    model: Schema.NonEmptyString,
    effort: Schema.optionalKey(ReasoningEffort),
    access: AccessMode,
  }),
});
export type CreateThreadPayload = typeof CreateThreadPayload.Type;

export const CeriumRpcs = RpcGroup.make(
  Rpc.make("ListThreads", { success: Schema.Array(ThreadOverview), error: CeriumError }),
  Rpc.make("ThreadEvents", {
    payload: { threadId: ThreadId },
    success: Schema.Array(AgentEvent),
    error: CeriumError,
  }),
  /** Every agent's events as they happen, streaming deltas included. */
  Rpc.make("WatchEvents", { success: AgentEvent, stream: true }),
  Rpc.make("CreateThread", {
    payload: CreateThreadPayload,
    success: Schema.Struct({ thread: ThreadInfo, lead: AgentInfo }),
    error: CeriumError,
  }),
  Rpc.make("SendMessage", {
    payload: { agentId: AgentId, text: Schema.NonEmptyString },
    error: CeriumError,
  }),
  Rpc.make("RespondToPermission", {
    payload: {
      agentId: AgentId,
      requestId: Schema.NonEmptyString,
      decision: Schema.Literals(["allow", "deny"]),
      scope: Schema.Literals(["once", "session"]),
    },
    error: CeriumError,
  }),
  Rpc.make("ResolveSpawnApproval", {
    payload: {
      requestId: Schema.NonEmptyString,
      decision: Schema.Literals(["allow", "deny"]),
      replacement: Schema.optionalKey(Schema.Struct({ provider: ProviderId, model: Schema.NonEmptyString })),
    },
    error: CeriumError,
  }),
  Rpc.make("InterruptAgent", {
    payload: { agentId: AgentId, includeChildren: Schema.optionalKey(Schema.Boolean) },
    error: CeriumError,
  }),
  Rpc.make("StopAgent", { payload: { agentId: AgentId }, error: CeriumError }),
  Rpc.make("HarnessStatuses", { success: Schema.Array(HarnessStatus) }),
);
