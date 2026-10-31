import type { AdapterEvent } from "@cerium/harness";
import { isAbsolute, resolve } from "node:path";
import type { EventPayload, ProviderId, ReasoningEffort, TodoItem } from "@cerium/protocol";

import type {
  ContentBlock,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
  ToolCallFields,
  ToolKind,
  TurnUsage,
} from "./schema.ts";

// Translates one ACP session's `session/update` notifications, and the answers to its prompts, into
// canonical events. A Cerium turn is one `session/prompt`: it ends when the prompt is answered. Text
// arrives as chunks; consecutive chunks of one kind (or one `messageId`) are one message, which
// completes when anything else arrives. Tool calls are announced, then patched by updates; Cerium
// reports one start (once the call has its input) and one end per call.

/** What the session feeds the translator. */
export type AcpRecord =
  /** The session was created, loaded or resumed. */
  | {
      readonly type: "opened";
      readonly sessionId: string;
      readonly model: string;
      readonly effort?: ReasoningEffort | undefined;
    }
  /** A `session/update` of this session. */
  | { readonly type: "update"; readonly update: SessionUpdate }
  /** The agent asked Cerium's permission (`session/request_permission`). */
  | { readonly type: "permission"; readonly requestId: string; readonly request: RequestPermissionRequest }
  /** Cerium sent a prompt. */
  | { readonly type: "prompt" }
  /** `session/prompt` answered: the turn is over. */
  | { readonly type: "prompted"; readonly response: PromptResponse }
  /** `session/prompt` failed, so the turn ends in an error. */
  | {
      readonly type: "promptFailed";
      readonly message: string;
      readonly code?: number | undefined;
      readonly auth?: boolean | undefined;
    }
  /** The turn was interrupted before its prompt was sent. */
  | { readonly type: "promptSkipped" };

/** A tool call as its updates have described it so far. */
export interface ToolCallState {
  readonly toolCallId: string;
  title?: string | undefined;
  name?: string | undefined;
  kind?: ToolKind | undefined;
  status?: string | undefined;
  content: ReadonlyArray<ToolCallContent>;
  locations: ReadonlyArray<{ readonly path: string; readonly line?: number | null }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  meta?: unknown;
}

/** A turn's spend in Cerium's terms, as a harness reads it from its own fields. */
export interface TurnTotals {
  /** Excluding cache reads. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

/** How a call is reported: Cerium's tool name for it and the input the transcript reads. */
export interface DescribedTool {
  readonly toolName: string;
  readonly input: unknown;
}

export interface TranslatorOptions {
  readonly provider: ProviderId;
  /** The harness's own login command, for `AuthRequired`. */
  readonly loginCommand?: string;
  /**
   * How a harness reports a call, before the generic description by kind. The MCP servers the
   * session knows let it spot their tools.
   */
  readonly describeTool?: (call: ToolCallState, servers: ReadonlyArray<string>) => DescribedTool | undefined;
  /** The MCP servers of this session, whose tools are reported as `mcp__<server>__<tool>`. */
  readonly mcpServers?: ReadonlyArray<string>;
  /**
   * Whether `session/prompt`'s `usage` counts the turn (`turn`) or the session so far (`session`). The
   * unstable schema reads both ways and agents differ.
   */
  readonly usage?: "turn" | "session";
  /** The model's context window when the agent's `usage_update` gives none. */
  readonly window?: () => number | undefined;
  /** A turn's spend from the agent's own fields, before ACP's `usage`. */
  readonly turnUsage?: (response: PromptResponse) => TurnTotals | undefined;
  /** The session's folder, which relative paths in tool calls are read against. */
  readonly cwd?: string;
}

type Chunk = "message" | "reasoning";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

const count = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const TODO_STATUS: Record<string, TodoItem["status"]> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

export class AcpTranslator {
  readonly #options: TranslatorOptions;
  readonly #servers: ReadonlyArray<string>;
  #started = false;
  #turn = 0;
  /** The message or reasoning streaming now, with what it said so far. */
  #open: { kind: Chunk; id: string; agentId: string | undefined; text: string } | undefined;
  #messages = 0;
  readonly #tools = new Map<string, ToolCallState & { started: boolean; ended: boolean }>();
  /** Permission requests asked and not yet answered, by Cerium's request id. */
  readonly #asks = new Map<string, RequestPermissionRequest>();
  /** The session's cumulative cost as the agent last reported it, and where this turn started. */
  #cost: { amount: number; currency: string } | undefined;
  #costAtTurnStart = 0;
  /** The agent's cumulative usage at the previous turn's end (for `usage: "session"`). */
  #usageBefore: TurnUsage | undefined;
  /** A compaction in progress, with its summary so far. */
  readonly #compactions = new Map<string, { summary: string; reported: boolean }>();
  /** The context before a compaction, as the latest `usage_update` measured it. */
  #context: number | undefined;
  /** Cerium asked for the compaction now running. */
  #manualCompaction = false;
  #compactedSinceAsked = false;

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#servers = options.mcpServers ?? [];
  }

  translate(record: AcpRecord): ReadonlyArray<AdapterEvent> {
    const raw =
      record.type === "update"
        ? record.update
        : record.type === "permission"
          ? record.request
          : record.type === "prompted"
            ? record.response
            : record;
    return this.#payloads(record).map((payload) => ({ payload, raw }));
  }

  /** The next compaction is Cerium's (`AgentSession.compact`). */
  compactAsked() {
    this.#manualCompaction = true;
    this.#compactedSinceAsked = false;
  }

  /**
   * A compact command's turn ended. An agent that reported no `compaction_update` for it still
   * compacted, as far as Cerium can tell: the command ran.
   */
  compactFinished(): ReadonlyArray<AdapterEvent> {
    if (!this.#manualCompaction || this.#compactedSinceAsked) return [];
    this.#manualCompaction = false;
    const before = this.#context;
    this.#context = undefined;
    return [
      {
        payload: {
          _tag: "ContextCompacted",
          trigger: "manual",
          ...(before === undefined ? {} : { tokensBefore: before }),
        },
      },
    ];
  }

  /** Folds what a permission request says of its call into what's known of it, reporting nothing. */
  track(fields: ToolCallFields): ToolCallState {
    let call = this.#tools.get(fields.toolCallId);
    if (call === undefined) {
      call = { toolCallId: fields.toolCallId, content: [], locations: [], started: false, ended: false };
      this.#tools.set(fields.toolCallId, call);
    }
    patch(call, fields, this.#options.cwd);
    return call;
  }

  /** An open permission request, for answering it. */
  ask(requestId: string): RequestPermissionRequest | undefined {
    return this.#asks.get(requestId);
  }

  /** Closes a permission request with Cerium's answer. */
  resolved(
    requestId: string,
    outcome: { readonly decision: "allow" | "deny"; readonly scope: "once" | "session" },
    raw?: unknown,
  ): ReadonlyArray<AdapterEvent> {
    if (!this.#asks.delete(requestId)) return [];
    return [{ payload: { _tag: "PermissionResolved", requestId, ...outcome }, raw }];
  }

  /** A turn is under way: a prompt was sent and not yet answered. */
  get inTurn(): boolean {
    return this.#turn > 0;
  }

  /** How a call reads in the transcript, for permission requests and history. */
  describe(call: ToolCallState): DescribedTool {
    const described =
      this.#options.describeTool?.(call, this.#servers) ?? describeByKind(call, this.#servers);
    const cwd = this.#options.cwd;
    if (cwd === undefined || !isRecord(described.input)) return described;
    // Paths the transcript reads, against the session's folder where the agent sent them relative.
    const input: Record<string, unknown> = { ...described.input };
    for (const key of ["path", "file_path"]) {
      const value = input[key];
      if (typeof value === "string" && value !== "" && !isAbsolute(value)) input[key] = resolve(cwd, value);
    }
    return { ...described, input };
  }

  #payloads(record: AcpRecord): ReadonlyArray<EventPayload> {
    switch (record.type) {
      case "opened":
        if (this.#started) return [];
        this.#started = true;
        return [
          {
            _tag: "SessionStarted",
            provider: this.#options.provider,
            providerSessionId: record.sessionId,
            model: record.model,
            ...(record.effort === undefined ? {} : { effort: record.effort }),
          },
        ];
      case "prompt":
        this.#turn++;
        this.#costAtTurnStart = this.#cost?.amount ?? 0;
        return [];
      case "update":
        return this.#update(record.update);
      case "permission":
        return this.#asked(record.requestId, record.request);
      case "prompted":
        return this.#prompted(record.response);
      case "promptFailed":
        return this.#endTurn("error", [errorPayload(record, this.#options)]);
      case "promptSkipped":
        return this.#endTurn("interrupted", []);
    }
  }

  #update(update: SessionUpdate): ReadonlyArray<EventPayload> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.#chunk("message", update.content, update.messageId ?? undefined);
      case "agent_thought_chunk":
        return this.#chunk("reasoning", update.content, update.messageId ?? undefined);
      case "user_message_chunk":
        // The prompt Cerium sent, echoed (or replayed by `session/load`, which history reads apart).
        return this.#closeChunk();
      case "tool_call":
      case "tool_call_update":
        return [...this.#closeChunk(), ...this.#toolCall(update, update.sessionUpdate === "tool_call")];
      case "plan":
        return [
          ...this.#closeChunk(),
          {
            _tag: "TodosUpdated",
            items: update.entries.flatMap((entry): ReadonlyArray<TodoItem> =>
              typeof entry.content === "string" && entry.content.trim() !== ""
                ? [{ text: entry.content, status: TODO_STATUS[entry.status] ?? "pending" }]
                : [],
            ),
          },
        ];
      case "usage_update": {
        if (isRecord(update.cost) && typeof update.cost.amount === "number") {
          this.#cost = { amount: update.cost.amount, currency: String(update.cost.currency) };
        }
        const tokens = count(update.used);
        if (tokens === 0) return [];
        this.#context = tokens;
        const window = count(update.size) || this.#options.window?.();
        return [{ _tag: "ContextReported", tokens, ...(window ? { window } : {}) }];
      }
      case "compaction_update":
        return this.#compaction(update);
      case "compaction_summary_chunk": {
        const compaction = this.#compactions.get(update.compactionId) ?? { summary: "", reported: false };
        compaction.summary += textOf(update.content);
        this.#compactions.set(update.compactionId, compaction);
        return [];
      }
      case "notice":
        // Warnings and errors are worth the user's eye; information is the agent's own chatter.
        return update.severity === "error" || update.severity === "warning"
          ? [
              {
                _tag: "AgentError",
                kind: "unknown",
                message: [update.title, update.description].filter(Boolean).join(": "),
                retryable: false,
              },
            ]
          : [];
      default:
        // Commands, modes, config options and titles carry nothing canonical; the session reads them.
        return [];
    }
  }

  #chunk(kind: Chunk, content: ContentBlock, agentId: string | undefined): ReadonlyArray<EventPayload> {
    const text = textOf(content);
    const open = this.#open;
    const same =
      open !== undefined && open.kind === kind && (agentId === undefined || agentId === open.agentId);
    const closed = same ? [] : this.#closeChunk();
    if (!same) {
      this.#messages++;
      this.#open = {
        kind,
        agentId,
        id: `${kind === "message" ? "msg" : "reasoning"}:${agentId ?? `${this.#turn}:${this.#messages}`}`,
        text: "",
      };
    }
    const current = this.#open!;
    current.text += text;
    if (text === "") return closed;
    return [
      ...closed,
      { _tag: kind === "message" ? "MessageDelta" : "ReasoningDelta", messageId: current.id, text },
    ];
  }

  #closeChunk(): ReadonlyArray<EventPayload> {
    const open = this.#open;
    this.#open = undefined;
    if (open === undefined || open.text.trim() === "") return [];
    return [
      {
        _tag: open.kind === "message" ? "MessageCompleted" : "ReasoningCompleted",
        messageId: open.id,
        text: open.text,
      },
    ];
  }

  #toolCall(fields: ToolCallFields, announced: boolean): ReadonlyArray<EventPayload> {
    const id = fields.toolCallId;
    let call = this.#tools.get(id);
    if (call === undefined) {
      call = { toolCallId: id, content: [], locations: [], started: false, ended: false };
      this.#tools.set(id, call);
    } else if (announced && call.ended) {
      // An id the agent reuses for a new call.
      call = { toolCallId: id, content: [], locations: [], started: false, ended: false };
      this.#tools.set(id, call);
    }
    patch(call, fields, this.#options.cwd);
    if (call.ended) return [];
    const status = call.status;
    if (status === "completed" || status === "failed") return this.#completeTool(call);
    // A call announced without its input yet starts once it runs, asks, or has its input.
    if (status === "in_progress" || hasInput(call.rawInput)) return this.#start(call);
    return [];
  }

  #start(call: ToolCallState & { started: boolean }): ReadonlyArray<EventPayload> {
    if (call.started) return [];
    call.started = true;
    const { toolName, input } = this.describe(call);
    return [{ _tag: "ToolCallStarted", callId: call.toolCallId, toolName, input }];
  }

  #completeTool(call: ToolCallState & { started: boolean; ended: boolean }): ReadonlyArray<EventPayload> {
    const started = this.#start(call);
    call.ended = true;
    const failed = call.status === "failed";
    return [
      ...started,
      {
        _tag: "ToolCallCompleted",
        callId: call.toolCallId,
        output: toolOutput(call),
        isError: failed || (exitCodeOf(call.rawOutput) !== undefined && exitCodeOf(call.rawOutput) !== 0),
      },
      ...(failed ? [] : fileChanges(call)),
    ];
  }

  #asked(requestId: string, request: RequestPermissionRequest): ReadonlyArray<EventPayload> {
    this.#asks.set(requestId, request);
    const closed = this.#closeChunk();
    // The request carries the call as it stands, which may be its first word of it.
    const fields = isRecord(request.toolCall) ? request.toolCall : { toolCallId: requestId };
    const known = this.#tools.get(fields.toolCallId);
    const call = known ?? {
      toolCallId: fields.toolCallId,
      content: [],
      locations: [],
      started: false,
      ended: false,
    };
    if (known === undefined) this.#tools.set(call.toolCallId, call);
    patch(call, fields, this.#options.cwd);
    const started = this.#start(call);
    const { toolName, input } = this.describe(call);
    return [
      ...closed,
      ...started,
      {
        _tag: "PermissionRequested",
        requestId,
        toolName,
        summary: permissionSummary(call, request.options),
        input,
      },
    ];
  }

  #compaction(
    update: Extract<SessionUpdate, { sessionUpdate: "compaction_update" }>,
  ): ReadonlyArray<EventPayload> {
    const compaction = this.#compactions.get(update.compactionId) ?? { summary: "", reported: false };
    this.#compactions.set(update.compactionId, compaction);
    if (Array.isArray(update.summary)) compaction.summary = update.summary.map(textOf).join("");
    if (compaction.reported) return [];
    if (update.status === "completed") {
      compaction.reported = true;
      const manual = this.#manualCompaction;
      this.#manualCompaction = false;
      this.#compactedSinceAsked = true;
      const summary = compaction.summary.trim();
      const before = this.#context;
      this.#context = undefined;
      return [
        ...this.#closeChunk(),
        {
          _tag: "ContextCompacted",
          trigger: manual ? "manual" : "auto",
          ...(before === undefined ? {} : { tokensBefore: before }),
          ...(summary === "" ? {} : { summary }),
        },
      ];
    }
    if (update.status === "failed") {
      compaction.reported = true;
      this.#manualCompaction = false;
      return [
        {
          _tag: "AgentError",
          kind: "unknown",
          message: `The conversation couldn't be compacted${update.error ? `: ${update.error}` : ""}`,
          retryable: false,
        },
      ];
    }
    return [];
  }

  #prompted(response: PromptResponse): ReadonlyArray<EventPayload> {
    const usage = this.#usagePayload(response);
    switch (response.stopReason) {
      case "cancelled":
        return this.#endTurn("interrupted", usage);
      case "max_turn_requests":
        return this.#endTurn("maxTurns", usage);
      case "refusal":
        return this.#endTurn("error", [
          ...usage,
          {
            _tag: "AgentError",
            kind: "unknown",
            message: "The model refused to continue.",
            retryable: false,
          },
        ]);
      case "max_tokens":
        return this.#endTurn("error", [
          ...usage,
          {
            _tag: "AgentError",
            kind: "unknown",
            message: "The reply ran out of tokens before it finished.",
            retryable: false,
          },
        ]);
      default:
        return this.#endTurn("completed", usage);
    }
  }

  #usagePayload(response: PromptResponse): ReadonlyArray<EventPayload> {
    const own = this.#options.turnUsage?.(response);
    if (own !== undefined) {
      return [
        {
          _tag: "UsageReported",
          inputTokens: count(own.inputTokens),
          outputTokens: count(own.outputTokens),
          ...(own.cachedInputTokens ? { cachedInputTokens: count(own.cachedInputTokens) } : {}),
          ...(own.costUsd !== undefined && own.costUsd > 0 ? { costUsd: own.costUsd } : {}),
        },
      ];
    }
    const usage = isRecord(response.usage) ? (response.usage as TurnUsage) : undefined;
    const cost = this.#cost;
    const spent =
      cost !== undefined && cost.currency.toUpperCase() === "USD"
        ? Math.max(0, cost.amount - this.#costAtTurnStart)
        : 0;
    if (usage === undefined) {
      // No token counts; a priced session still says what the turn cost.
      return spent > 0 ? [{ _tag: "UsageReported", inputTokens: 0, outputTokens: 0, costUsd: spent }] : [];
    }
    const before = this.#options.usage === "session" ? this.#usageBefore : undefined;
    this.#usageBefore = usage;
    const delta = (key: keyof TurnUsage) => count((usage[key] ?? 0) - (before?.[key] ?? 0));
    const cachedRead = delta("cachedReadTokens");
    // Cerium's input excludes cache reads; cache writes are new input. ACP's input counts every prompt
    // token, so the reads come off it where the agent reports them.
    const input = Math.max(0, delta("inputTokens") - cachedRead);
    const output = delta("outputTokens") + delta("thoughtTokens");
    return [
      {
        _tag: "UsageReported",
        inputTokens: input,
        outputTokens: output,
        ...(cachedRead > 0 ? { cachedInputTokens: cachedRead } : {}),
        ...(spent > 0 ? { costUsd: spent } : {}),
      },
    ];
  }

  #endTurn(
    reason: "completed" | "interrupted" | "maxTurns" | "error",
    extra: ReadonlyArray<EventPayload>,
  ): ReadonlyArray<EventPayload> {
    const payloads: Array<EventPayload> = [...this.#closeChunk()];
    for (const call of this.#tools.values()) {
      if (call.ended || !call.started) continue;
      call.ended = true;
      payloads.push({
        _tag: "ToolCallCompleted",
        callId: call.toolCallId,
        output: "The turn ended before this tool call finished.",
        isError: true,
      });
    }
    this.#tools.clear();
    for (const requestId of this.#asks.keys()) {
      payloads.push({ _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" });
    }
    this.#asks.clear();
    this.#turn = Math.max(0, this.#turn - 1);
    payloads.push(...extra, { _tag: "TurnCompleted", stopReason: reason });
    return payloads;
  }
}

/** Copies what an update says over what the call held (ACP updates replace each field they carry). */
const patch = (call: ToolCallState, fields: ToolCallFields, cwd: string | undefined) => {
  const absolute = (path: string) => (cwd === undefined || isAbsolute(path) ? path : resolve(cwd, path));
  if (stringOf(fields.title)) call.title = fields.title!;
  if (stringOf(fields.name)) call.name = fields.name!;
  if (typeof fields.kind === "string") call.kind = fields.kind;
  if (typeof fields.status === "string") call.status = fields.status;
  if (Array.isArray(fields.content)) {
    call.content = fields.content.map((item) =>
      isRecord(item) && item.type === "diff" && typeof item.path === "string"
        ? { ...item, path: absolute(item.path) }
        : item,
    );
  }
  if (Array.isArray(fields.locations)) {
    call.locations = fields.locations.flatMap((location) =>
      isRecord(location) && typeof location.path === "string"
        ? [{ ...location, path: absolute(location.path) }]
        : [],
    );
  }
  if (fields.rawInput !== undefined && fields.rawInput !== null) call.rawInput = fields.rawInput;
  if (fields.rawOutput !== undefined && fields.rawOutput !== null) call.rawOutput = fields.rawOutput;
  if (fields._meta !== undefined && fields._meta !== null) call.meta = fields._meta;
};

const hasInput = (input: unknown) => isRecord(input) && Object.keys(input).length > 0;

/** A content block's text; other blocks as a word on what they are. */
export const textOf = (content: ContentBlock | undefined): string => {
  if (!isRecord(content)) return "";
  switch (content.type) {
    case "text":
      return typeof content.text === "string" ? content.text : "";
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource":
      return "text" in content.resource && typeof content.resource.text === "string"
        ? content.resource.text
        : "";
    default:
      return "";
  }
};

const exitCodeOf = (output: unknown): number | undefined => {
  if (!isRecord(output)) return undefined;
  for (const key of ["exitCode", "exit_code", "code"]) {
    const value = output[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
};

/** A dot-free `mcp__server__tool`, or `server/tool`, `server.tool`, `server__tool` of a known server. */
export const mcpToolName = (name: string | undefined, servers: ReadonlyArray<string>): string | undefined => {
  if (name === undefined) return undefined;
  if (/^mcp__.+__.+/.test(name)) return name;
  // Longest first, so `my_server` wins over `my` for `my_server_tool`.
  const sorted = [...servers].sort((a, b) => b.length - a.length);
  for (const server of sorted) {
    for (const separator of ["__", "/", ".", ":", "_"]) {
      const prefix = `${server}${separator}`;
      if (name.startsWith(prefix) && name.length > prefix.length) {
        return `mcp__${server}__${name.slice(prefix.length)}`;
      }
    }
  }
  return undefined;
};

const firstPath = (call: ToolCallState) =>
  call.locations.find((location) => stringOf(location.path))?.path ??
  call.content.find((item) => item.type === "diff")?.path;

const field = (input: unknown, ...keys: ReadonlyArray<string>) => {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = stringOf(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * A call by its ACP kind, named as Cerium's transcript knows each kind of tool (`read`, `edit`,
 * `write`, `shell`, `grep`, `webfetch`…), with the fields it reads (`path`, `command`, `pattern`,
 * `url`, `old_string`/`new_string`) beside the agent's own input. An MCP server's tool keeps its
 * `mcp__<server>__<tool>` name.
 */
export const describeByKind = (call: ToolCallState, servers: ReadonlyArray<string>): DescribedTool => {
  const raw = isRecord(call.rawInput) ? call.rawInput : {};
  const mcp = mcpToolName(call.name, servers) ?? mcpToolName(call.title, servers);
  if (mcp !== undefined) return { toolName: mcp, input: raw };
  const path = field(raw, "file_path", "path", "filePath", "absolute_path", "target_file") ?? firstPath(call);
  const withPath = path === undefined ? raw : { ...raw, path };
  const diffs = call.content.flatMap((item) => (item.type === "diff" ? [item] : []));
  switch (call.kind) {
    case "read":
      return { toolName: "read", input: withPath };
    case "edit": {
      const diff = diffs[0];
      if (diff === undefined) return { toolName: "edit", input: withPath };
      // A new file is a write; anything else is the edit's before and after.
      if (diff.oldText === undefined || diff.oldText === null) {
        return { toolName: "write", input: { ...withPath, path: diff.path, content: diff.newText } };
      }
      if (diffs.length > 1) {
        return {
          toolName: "edit",
          input: {
            ...withPath,
            path: diff.path,
            edits: diffs.map((each) => ({ old_string: each.oldText ?? "", new_string: each.newText })),
          },
        };
      }
      return {
        toolName: "edit",
        input: { ...withPath, path: diff.path, old_string: diff.oldText, new_string: diff.newText },
      };
    }
    case "delete":
      return { toolName: "delete", input: withPath };
    case "move":
      return { toolName: "move", input: withPath };
    case "search": {
      const pattern = field(raw, "pattern", "query", "regex", "glob") ?? call.title ?? "";
      return { toolName: "grep", input: { ...withPath, pattern } };
    }
    case "execute": {
      const command = field(raw, "command", "cmd") ?? arrayCommand(raw["command"]) ?? call.title ?? "";
      const description = field(raw, "description");
      return { toolName: "shell", input: { ...raw, command, ...(description ? { description } : {}) } };
    }
    case "fetch": {
      const url = field(raw, "url", "uri");
      if (url !== undefined) return { toolName: "webfetch", input: { ...raw, url } };
      const query = field(raw, "query", "q") ?? call.title ?? "";
      return { toolName: "websearch", input: { ...raw, query } };
    }
    default: {
      const name = call.name ?? (call.kind === "think" ? "think" : undefined) ?? call.title ?? "tool";
      const title = call.title !== undefined && call.title !== name ? { title: call.title } : {};
      return { toolName: name, input: { ...title, ...withPath } };
    }
  }
};

const arrayCommand = (value: unknown) =>
  Array.isArray(value) && value.every((part) => typeof part === "string") ? value.join(" ") : undefined;

/**
 * A call's result as the transcript reads it: a command's output with its exit code, text, or MCP-style
 * content items with images inline (a computer-use screenshot).
 */
export const toolOutput = (call: ToolCallState): unknown => {
  const blocks = call.content.flatMap((item) => (item.type === "content" ? [item.content] : []));
  const text = blocks
    .map(textOf)
    .filter((part) => part !== "")
    .join("\n");
  const exitCode = exitCodeOf(call.rawOutput);
  if (exitCode !== undefined) {
    const printed = text || field(call.rawOutput, "output", "stdout", "formatted_output") || "";
    return { output: printed, exitCode };
  }
  const images = blocks.filter((block) => isRecord(block) && block.type === "image");
  if (images.length > 0) {
    return blocks.map((block) =>
      block.type === "image"
        ? { type: "image", mimeType: block.mimeType, data: block.data }
        : { type: "text", text: textOf(block) },
    );
  }
  if (text !== "") return text;
  const diffs = call.content.filter((item) => item.type === "diff");
  if (diffs.length > 0) return diffs.map((diff) => `Edited ${diff.path}`).join("\n");
  if (call.rawOutput !== undefined) return call.rawOutput;
  return "";
};

/** The files a finished call changed: its diffs, and what a delete or move named. */
const fileChanges = (call: ToolCallState): ReadonlyArray<EventPayload> => {
  const diffs = call.content.flatMap((item) => (item.type === "diff" ? [item] : []));
  if (diffs.length > 0) {
    return diffs.map((diff) => ({
      _tag: "FileChanged",
      path: diff.path,
      change: diff.oldText === undefined || diff.oldText === null ? "created" : "modified",
    }));
  }
  if (call.kind === "delete") {
    return call.locations.map((location) => ({
      _tag: "FileChanged",
      path: location.path,
      change: "deleted",
    }));
  }
  if (call.kind === "edit") {
    return call.locations.map((location) => ({
      _tag: "FileChanged",
      path: location.path,
      change: "modified",
    }));
  }
  return [];
};

/** One line saying what a permission request wants to do: the call's own title, else its kind. */
export const permissionSummary = (call: ToolCallState, options: ReadonlyArray<PermissionOption>): string => {
  const title = call.title?.trim();
  if (title) return title;
  const path = firstPath(call);
  const verbs: Partial<Record<ToolKind, string>> = {
    read: "Read",
    edit: "Edit",
    delete: "Delete",
    move: "Move",
    search: "Search",
    execute: "Run a command",
    fetch: "Fetch",
  };
  const verb = call.kind === undefined ? undefined : verbs[call.kind];
  if (verb !== undefined) return path === undefined ? verb : `${verb} ${path}`;
  return options[0]?.name ?? "Use a tool";
};

/** A failed prompt as a canonical error. */
const errorPayload = (
  failure: {
    readonly message: string;
    readonly code?: number | undefined;
    readonly auth?: boolean | undefined;
  },
  options: TranslatorOptions,
): EventPayload => {
  if (failure.auth === true || failure.code === -32000) {
    return {
      _tag: "AuthRequired",
      provider: options.provider,
      reason: failure.message,
      ...(options.loginCommand ? { loginCommand: options.loginCommand } : {}),
    };
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(failure.message)) {
    return { _tag: "AgentError", kind: "rateLimit", message: failure.message, retryable: true };
  }
  if (/quota|usage limit|limit reached|out of credits|insufficient credits/i.test(failure.message)) {
    return { _tag: "LimitReached", provider: options.provider, message: failure.message };
  }
  if (/timed? ?out|ECONNRESET|network|unavailable|overloaded|\b5\d\d\b/i.test(failure.message)) {
    return { _tag: "AgentError", kind: "transient", message: failure.message, retryable: true };
  }
  return { _tag: "AgentError", kind: "unknown", message: failure.message, retryable: false };
};
