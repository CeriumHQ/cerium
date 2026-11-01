import { LenientArray, type CapabilityManifest } from "@cerium/protocol";
import { Schema } from "effect";

// The Agent Client Protocol (v1) messages Cerium reads, after the official schema
// (`@agentclientprotocol/sdk` 2.2.0, `schema/v1/schema.unstable.json`). Read as leniently as the
// spec asks of clients: lists skip the items they can't read, nullable fields take `null`, and
// fields Cerium doesn't use are left alone. Requests Cerium sends are plain objects in the spec's
// shape (`client.ts`).

/** The `_meta` every ACP object may carry: the agent's own extensions. */
export const Meta = Schema.Record(Schema.String, Schema.Unknown);
export type Meta = typeof Meta.Type;

const meta = Schema.optionalKey(Schema.NullOr(Meta));
const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

export const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  uri: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.Unknown),
});
export type ContentBlock = typeof ContentBlock.Type;

export const ToolCallContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), content: ContentBlock }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    oldText: nullable(Schema.String),
    newText: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("terminal"), terminalId: Schema.String }),
]);
export type ToolCallContent = typeof ToolCallContent.Type;

const ToolCallLocation = Schema.Struct({ path: Schema.String, line: nullable(Schema.Finite) });

/**
 * A tool call as `tool_call` reports it and `tool_call_update` amends it: an update carries only the
 * fields that changed. `kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`,
 * `fetch`, `switch_mode` and `other`; `status` one of `pending`, `in_progress`, `completed` and
 * `failed`. Both read as plain strings, so a value a newer agent adds doesn't drop the update.
 */
const toolCallFields = {
  toolCallId: Schema.String,
  title: nullable(Schema.String),
  /** The tool's own name, which newer agents send beside the title. */
  name: nullable(Schema.String),
  kind: nullable(Schema.String),
  status: nullable(Schema.String),
  content: nullable(LenientArray(ToolCallContent)),
  locations: nullable(LenientArray(ToolCallLocation)),
  rawInput: Schema.optionalKey(Schema.Unknown),
  rawOutput: Schema.optionalKey(Schema.Unknown),
  _meta: meta,
};
export const ToolCall = Schema.Struct(toolCallFields);
export type ToolCall = typeof ToolCall.Type;

const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: nullable(Schema.String),
  status: nullable(Schema.String),
});

const AvailableCommand = Schema.Struct({
  name: Schema.String,
  description: nullable(Schema.String),
});
export type AvailableCommand = typeof AvailableCommand.Type;

const SelectChoice = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: nullable(Schema.String),
  _meta: meta,
});
export type SelectChoice = typeof SelectChoice.Type;

const SelectGroup = Schema.Struct({
  group: Schema.String,
  name: nullable(Schema.String),
  options: LenientArray(SelectChoice),
});

/**
 * One of a session's settings. Cerium reads `select` ones, whose `options` are choices or groups of
 * them (`choicesOf`); `category` names what it sets: `model`, `thought_level` (effort), `mode`, ….
 */
export const ConfigOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  category: nullable(Schema.String),
  type: Schema.String,
  currentValue: Schema.optionalKey(Schema.Unknown),
  options: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  _meta: meta,
});
export type ConfigOption = typeof ConfigOption.Type;

const decodeChoice = Schema.decodeUnknownOption(SelectChoice);
const decodeGroup = Schema.decodeUnknownOption(SelectGroup);

/** A select option's choices, its groups flattened in order. */
export const choicesOf = (option: ConfigOption): ReadonlyArray<SelectChoice> =>
  (option.options ?? []).flatMap((each) => {
    const choice = decodeChoice(each);
    if (choice._tag === "Some") return [choice.value];
    const group = decodeGroup(each);
    return group._tag === "Some" ? group.value.options : [];
  });

/** A select option's current value, or nothing for another type of option. */
export const currentChoice = (option: ConfigOption): string | undefined =>
  option.type === "select" && typeof option.currentValue === "string" ? option.currentValue : undefined;

const Cost = Schema.Struct({ amount: Schema.Finite, currency: Schema.String });

/** Token counts, which ACP's `PromptResponse.usage` gives for the turn. */
export const Usage = Schema.Struct({
  totalTokens: nullable(Schema.Finite),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  thoughtTokens: nullable(Schema.Finite),
  cachedReadTokens: nullable(Schema.Finite),
  cachedWriteTokens: nullable(Schema.Finite),
});
export type Usage = typeof Usage.Type;

const chunk = <T extends string>(tag: T) =>
  Schema.Struct({
    sessionUpdate: Schema.Literal(tag),
    content: ContentBlock,
    messageId: nullable(Schema.String),
    _meta: meta,
  });

export const SessionUpdate = Schema.Union([
  chunk("user_message_chunk"),
  chunk("agent_message_chunk"),
  chunk("agent_thought_chunk"),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call"), ...toolCallFields }),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call_update"), ...toolCallFields }),
  Schema.Struct({ sessionUpdate: Schema.Literal("plan"), entries: LenientArray(PlanEntry) }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: LenientArray(AvailableCommand),
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("current_mode_update"), currentModeId: Schema.String }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("config_option_update"),
    configOptions: LenientArray(ConfigOption),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("session_info_update"),
    title: nullable(Schema.String),
    updatedAt: nullable(Schema.String),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"),
    used: Schema.Finite,
    size: Schema.Finite,
    cost: nullable(Cost),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("compaction_update"),
    compactionId: Schema.String,
    status: Schema.String,
    summary: nullable(LenientArray(ContentBlock)),
    error: nullable(Schema.String),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("notice"),
    severity: Schema.String,
    title: Schema.String,
  }),
]);
export type SessionUpdate = typeof SessionUpdate.Type;

export const SessionNotification = Schema.Struct({
  sessionId: Schema.String,
  update: SessionUpdate,
  _meta: meta,
});
export type SessionNotification = typeof SessionNotification.Type;

const ModelState = Schema.Struct({
  currentModelId: Schema.String,
  availableModels: LenientArray(
    Schema.Struct({
      modelId: Schema.String,
      name: Schema.String,
      description: nullable(Schema.String),
      _meta: meta,
    }),
  ),
});
export type ModelState = typeof ModelState.Type;

const ModeState = Schema.Struct({
  currentModeId: Schema.String,
  availableModes: LenientArray(
    Schema.Struct({ id: Schema.String, name: Schema.String, description: nullable(Schema.String) }),
  ),
});

/** What `session/new`, `session/load` and `session/resume` answer, the id only from the first. */
export const SessionSetup = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  configOptions: nullable(LenientArray(ConfigOption)),
  /** The model picker of agents that predate config options (unstable in the spec). */
  models: nullable(ModelState),
  modes: nullable(ModeState),
  _meta: meta,
});
export type SessionSetup = typeof SessionSetup.Type;

export const PromptResult = Schema.Struct({
  stopReason: Schema.String,
  usage: nullable(Usage),
  _meta: meta,
});
export type PromptResult = typeof PromptResult.Type;

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  /** `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
  kind: Schema.String,
});
export type PermissionOption = typeof PermissionOption.Type;

export const PermissionRequest = Schema.Struct({
  sessionId: Schema.String,
  toolCall: ToolCall,
  options: LenientArray(PermissionOption),
  _meta: meta,
});
export type PermissionRequest = typeof PermissionRequest.Type;

export const SessionInfo = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  title: nullable(Schema.String),
  updatedAt: nullable(Schema.String),
  _meta: meta,
});
export type SessionInfo = typeof SessionInfo.Type;

export const SessionList = Schema.Struct({
  sessions: LenientArray(SessionInfo),
  nextCursor: nullable(Schema.String),
});

const AuthMethod = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: nullable(Schema.String),
});

const flag = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
/** A capability the spec marks by an empty object being present. */
const present = Schema.optionalKey(Schema.NullOr(Schema.Unknown));

export const Initialized = Schema.Struct({
  protocolVersion: Schema.Finite,
  agentCapabilities: nullable(
    Schema.Struct({
      loadSession: flag,
      promptCapabilities: nullable(Schema.Struct({ image: flag, audio: flag, embeddedContext: flag })),
      mcpCapabilities: nullable(Schema.Struct({ http: flag, sse: flag })),
      sessionCapabilities: nullable(
        Schema.Struct({ list: present, resume: present, close: present, fork: present }),
      ),
      _meta: meta,
    }),
  ),
  authMethods: nullable(LenientArray(AuthMethod)),
  agentInfo: nullable(
    Schema.Struct({ name: Schema.String, version: Schema.String, title: nullable(Schema.String) }),
  ),
  _meta: meta,
});
export type Initialized = typeof Initialized.Type;

/** What the agent says it can do, as the session runner asks it. */
export const capabilitiesOf = (initialized: Initialized) => {
  const agent = initialized.agentCapabilities ?? {};
  const sessions = agent.sessionCapabilities ?? {};
  const present = (value: unknown) => value !== undefined && value !== null;
  return {
    load: agent.loadSession === true,
    resume: present(sessions.resume),
    list: present(sessions.list),
    close: present(sessions.close),
    images: agent.promptCapabilities?.image === true,
    httpMcp: agent.mcpCapabilities?.http === true,
  };
};
export type AgentCapabilities = ReturnType<typeof capabilitiesOf>;

/** Negotiation can take a claimed capability away; it cannot promise an unimplemented one. */
export const negotiatedManifest = (
  manifest: CapabilityManifest,
  initialized: Initialized,
): CapabilityManifest => {
  const capabilities = capabilitiesOf(initialized);
  return {
    ...manifest,
    session: {
      ...manifest.session,
      resume: manifest.session.resume && (capabilities.resume || capabilities.load),
    },
    input: { images: manifest.input.images && capabilities.images },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A path into an agent's `_meta`, or nothing where it doesn't lead anywhere. */
export const metaAt = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let at: unknown = value;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
};

/** The text of content blocks, joined; images and other blocks leave none. */
export const textOf = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
