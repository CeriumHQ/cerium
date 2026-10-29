import { Schema } from "effect";

import { EpochMillis, ThreadId } from "./ids.ts";
import { MAX_THREAD_TITLE } from "./orchestration.ts";

// Assistants: chat apps outside Cerium (Grok, ChatGPT, Claude and others) the user connects to their
// account as an MCP connector at the relay's `/mcp`. An assistant asks the relay, the relay asks one
// of the account's desktops, and only a desktop whose user turned assistants on in its settings
// answers. What a desktop does for one is what the user could do in its window: start a thread, or
// send one of its leads a message.

/** What an assistant calls itself when it connects, as the user sees it. */
export const MAX_ASSISTANT_NAME = 64;
export const AssistantName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ASSISTANT_NAME),
);

/** The longest request an assistant may hand a thread's lead, in characters. */
export const MAX_ASSISTANT_PROMPT = 32_000;

const Prompt = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_ASSISTANT_PROMPT));

/** One call of an assistant's, as the relay hands it to a desktop. */
export const AssistantRequest = Schema.Union([
  /** The folders the user keeps as projects on the desktop, most recently used first. */
  Schema.TaggedStruct("ListProjects", {}),
  /** The models a thread can start on there, by the aliases `StartThread` takes. */
  Schema.TaggedStruct("ListModels", {}),
  /**
   * A new thread whose lead takes `prompt` as the user's request: a work thread in `project`, or a
   * chat without one.
   */
  Schema.TaggedStruct("StartThread", {
    prompt: Prompt,
    /** A project's path as `ListProjects` gives it, or its folder's name when that is one project's. */
    project: Schema.optionalKey(Schema.NonEmptyString),
    title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_THREAD_TITLE))),
    /** An alias `ListModels` gives; the desktop's first roster model without one. */
    model: Schema.optionalKey(Schema.NonEmptyString),
    /** Run it in a git worktree of its own, apart from other threads' changes. */
    worktree: Schema.optionalKey(Schema.Boolean),
  }),
  /** A message to a thread's lead, as if the user typed it in the thread. */
  Schema.TaggedStruct("SendToThread", { threadId: ThreadId, text: Prompt }),
]);
export type AssistantRequest = typeof AssistantRequest.Type;

/** A desktop's answer to an assistant's call. */
export const AssistantResult = Schema.Union([
  Schema.TaggedStruct("Projects", {
    projects: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
  }),
  Schema.TaggedStruct("Models", {
    models: Schema.Array(
      Schema.Struct({ alias: Schema.String, description: Schema.String, default: Schema.Boolean }),
    ),
  }),
  Schema.TaggedStruct("ThreadStarted", { threadId: ThreadId, title: Schema.String }),
  Schema.TaggedStruct("Sent", {}),
  /** It couldn't, for the reason `message` gives, written for the assistant to pass on. */
  Schema.TaggedStruct("Refused", { message: Schema.String }),
]);
export type AssistantResult = typeof AssistantResult.Type;

/** Names one call between the relay and a desktop, so its answer finds the request waiting on it. */
export const AssistantCallId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));
export type AssistantCallId = typeof AssistantCallId.Type;

/** What a desktop tells its relay socket about assistants. */
export const AssistantMessage = Schema.Union([
  /**
   * Whether this desktop takes assistants' calls, which its user decides in its settings: said on
   * every connection, and again whenever it changes. A desktop that never says so takes none.
   */
  Schema.TaggedStruct("OfferAssistants", { enabled: Schema.Boolean }),
  /** The answer to an `AssistantCall`. */
  Schema.TaggedStruct("AssistantReply", { id: AssistantCallId, result: AssistantResult }),
]);
export type AssistantMessage = typeof AssistantMessage.Type;

/** What the relay sends a desktop that takes assistants' calls. */
export const AssistantNotice = Schema.Union([
  Schema.TaggedStruct("AssistantCall", {
    id: AssistantCallId,
    /** The connected assistant that asked, by the name it connected with. */
    assistant: AssistantName,
    request: AssistantRequest,
  }),
]);
export type AssistantNotice = typeof AssistantNotice.Type;

/** An assistant connected to the account, as Settings lists it to disconnect. */
export const ConnectedAssistant = Schema.Struct({
  id: Schema.String,
  name: AssistantName,
  /** Where it sends the user back after they allow it, which tells apart two of the same name. */
  site: Schema.String,
  connectedAt: EpochMillis,
  lastUsedAt: Schema.optionalKey(EpochMillis),
});
export type ConnectedAssistant = typeof ConnectedAssistant.Type;

/** `GET /api/assistants`: the account's connected assistants. */
export const ConnectedAssistants = Schema.Struct({ assistants: Schema.Array(ConnectedAssistant) });
export type ConnectedAssistants = typeof ConnectedAssistants.Type;

/** A thread an assistant started, or messaged, as the thread shows it. */
export const AssistantOrigin = Schema.Struct({ assistant: AssistantName });
export type AssistantOrigin = typeof AssistantOrigin.Type;

/** Where the relay serves its MCP endpoint, which the user adds to an assistant as a connector. */
export const ASSISTANT_MCP_PATH = "/mcp";
