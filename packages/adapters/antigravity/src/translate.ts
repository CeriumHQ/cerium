import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload, ReasoningEffort } from "@cerium/protocol";
import { isAbsolute, resolve } from "node:path";

import { LOGIN_COMMAND } from "./manifest.ts";
import { describeTool, toolClass } from "./tools.ts";

// Translates the headless stream of `agy --output-format stream-json` into canonical events. The stream
// is documented (antigravity.google/docs/cli/headless): one `init`, then `step_update`s, then one
// `result` per turn. What the docs leave out is read defensively: the conversation id sits at the top
// of `init` in practice (prior art), tool arguments are PascalCase, and a step can arrive DONE without
// an ACTIVE first. One Cerium turn is one `agy` run.

/** One line of the stream, as far as Cerium reads it. */
export interface AgyEvent {
  readonly event: string;
  readonly conversation_id?: string;
  readonly init?: { readonly conversation_id?: string; readonly model?: string; readonly cwd?: string };
  readonly step_update?: AgyStep;
  readonly result?: AgyResult;
}

export interface AgyUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly thinking_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly total_tokens?: number;
}

export interface AgyStep {
  readonly conversation_id?: string;
  readonly step_index?: number;
  readonly state?: string;
  readonly step_type?: string;
  readonly tool_name?: string;
  readonly text_delta?: string;
  readonly thinking_delta?: string;
  readonly usage?: AgyUsage;
  readonly tool_info?: {
    readonly name?: string;
    readonly parameters?: Record<string, unknown>;
    readonly output?: unknown;
    readonly error?: { readonly type?: string; readonly message?: string } | null;
  };
}

export interface AgyResult {
  readonly conversation_id?: string;
  readonly status?: string;
  readonly response?: string;
  readonly error?: string;
  readonly usage?: AgyUsage;
  readonly denied_actions?: ReadonlyArray<{ readonly action?: string; readonly display_name?: string }>;
  readonly finished_reason?: string;
}

/** What the session feeds the translator. */
export type AgyRecord =
  /** The session opened; a resumed one already has its id, a new one gets it from its first run. */
  | {
      readonly type: "opened";
      readonly sessionId?: string | undefined;
      readonly model: string;
      readonly effort?: ReasoningEffort | undefined;
    }
  /** A run started for a turn. */
  | { readonly type: "run" }
  /** One line of a run's stream. */
  | { readonly type: "event"; readonly event: AgyEvent }
  /** The run's process ended. `stderr` holds its last words. */
  | { readonly type: "exited"; readonly code: number | undefined; readonly stderr?: string | undefined }
  /** The run never started. */
  | { readonly type: "failed"; readonly message: string };

export interface TranslatorOptions {
  /** Injected MCP servers, whose tools are reported as `mcp__<server>__<tool>`. */
  readonly mcpServers?: ReadonlyArray<string>;
  /** The plugin Cerium's servers come from, which namespaces them `<plugin>_<server>`. */
  readonly plugin?: string;
  readonly cwd?: string;
}

const count = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `AGY_ERROR: {...}` (documented as structured, keys undocumented) or `error: …` on stderr. */
export const stderrError = (stderr: string | undefined): string | undefined => {
  if (stderr === undefined) return undefined;
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  const structured = lines.findLast((line) => line.startsWith("AGY_ERROR:"));
  if (structured !== undefined) {
    const text = structured.slice("AGY_ERROR:".length).trim();
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const message = ["message", "error", "status", "detail"]
          .map((key) => parsed[key])
          .find((value) => typeof value === "string");
        if (typeof message === "string") return message;
      }
    } catch {
      // Not JSON after all: the line as written.
    }
    return text;
  }
  return (
    lines.findLast((line) => /^error:/i.test(line))?.replace(/^error:\s*/i, "") ??
    lines.findLast((line) => line !== "")
  );
};

/** An error's words as the canonical error they mean. */
export const errorPayload = (message: string): EventPayload => {
  if (
    /authentication (failed|required|expired)|not logged in|please (log|sign) in|sign in to/i.test(message)
  ) {
    return { _tag: "AuthRequired", provider: "antigravity", reason: message, loginCommand: LOGIN_COMMAND };
  }
  if (/RESOURCE_EXHAUSTED|quota|usage limit|daily limit|out of credits|resets in/i.test(message)) {
    const resets = /resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(message);
    const seconds = resets
      ? Number(resets[1] ?? 0) * 3600 + Number(resets[2] ?? 0) * 60 + Number(resets[3] ?? 0)
      : 0;
    return {
      _tag: "LimitReached",
      provider: "antigravity",
      message,
      ...(seconds > 0 ? { resetsAt: Date.now() + seconds * 1000 } : {}),
    };
  }
  if (/rate.?limit|\b429\b/i.test(message)) {
    return { _tag: "AgentError", kind: "rateLimit", message, retryable: true };
  }
  if (/\b50[234]\b|unavailable|timed? ?out|ECONNRESET|deadline/i.test(message)) {
    return { _tag: "AgentError", kind: "transient", message, retryable: true };
  }
  return { _tag: "AgentError", kind: "unknown", message, retryable: false };
};

interface OpenTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly native: string;
}

export class AgyTranslator {
  readonly #options: TranslatorOptions;
  #sessionId: string | undefined;
  #model = "";
  #effort: ReasoningEffort | undefined;
  #started = false;
  #runs = 0;
  #inRun = false;
  /** Text and reasoning still streaming, by message id. */
  readonly #text = new Map<string, { readonly tag: "message" | "reasoning"; text: string }>();
  /** Tool steps started and not ended, by call id. */
  readonly #tools = new Map<string, OpenTool>();

  constructor(options: TranslatorOptions = {}) {
    this.#options = options;
  }

  /** The conversation's id once a run has named it. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** A turn is under way. */
  get inRun(): boolean {
    return this.#inRun;
  }

  translate(record: AgyRecord): ReadonlyArray<AdapterEvent> {
    const raw = record.type === "event" ? record.event : record;
    return this.#payloads(record).map((payload) => ({ payload, raw }));
  }

  #payloads(record: AgyRecord): ReadonlyArray<EventPayload> {
    switch (record.type) {
      case "opened":
        this.#model = record.model;
        this.#effort = record.effort;
        this.#sessionId = record.sessionId;
        return record.sessionId === undefined ? [] : this.#start(record.sessionId);
      case "run":
        this.#runs++;
        this.#inRun = true;
        return [];
      case "event":
        return this.#event(record.event);
      case "exited":
        // A run that ended without its result (killed, crashed): its turn ends now.
        if (!this.#inRun) return [];
        return this.#endTurn("error", [
          errorPayload(
            stderrError(record.stderr) ??
              `Antigravity exited${record.code === undefined ? "" : ` with code ${record.code}`} before finishing the turn`,
          ),
        ]);
      case "failed":
        if (!this.#inRun) this.#inRun = true;
        return this.#endTurn("error", [errorPayload(record.message)]);
    }
  }

  #start(sessionId: string): ReadonlyArray<EventPayload> {
    if (this.#started) return [];
    this.#started = true;
    this.#sessionId = sessionId;
    return [
      {
        _tag: "SessionStarted",
        provider: "antigravity",
        providerSessionId: sessionId,
        model: this.#model,
        ...(this.#effort === undefined ? {} : { effort: this.#effort }),
      },
    ];
  }

  /** The conversation id an event names, wherever this version puts it. */
  #conversation(event: AgyEvent): string | undefined {
    const id =
      event.conversation_id ??
      event.init?.conversation_id ??
      event.step_update?.conversation_id ??
      event.result?.conversation_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  }

  #event(event: AgyEvent): ReadonlyArray<EventPayload> {
    const conversation = this.#conversation(event);
    const started = conversation === undefined ? [] : this.#start(conversation);
    switch (event.event) {
      case "step_update":
        return [...started, ...(event.step_update === undefined ? [] : this.#step(event.step_update))];
      case "result":
        return [...started, ...(event.result === undefined ? [] : this.#result(event.result))];
      default:
        // `init` names the conversation and its tools; nothing else is canonical.
        return started;
    }
  }

  #step(step: AgyStep): ReadonlyArray<EventPayload> {
    const index = step.step_index ?? 0;
    const done = step.state === "DONE";
    switch (step.step_type) {
      case "agent_response": {
        const payloads: Array<EventPayload> = [];
        if (typeof step.thinking_delta === "string" && step.thinking_delta !== "") {
          payloads.push(...this.#delta("reasoning", `reasoning:${this.#runs}:${index}`, step.thinking_delta));
        }
        if (typeof step.text_delta === "string" && step.text_delta !== "") {
          payloads.push(...this.#delta("message", `msg:${this.#runs}:${index}`, step.text_delta));
        }
        if (done) {
          payloads.push(
            ...this.#close(`reasoning:${this.#runs}:${index}`),
            ...this.#close(`msg:${this.#runs}:${index}`),
          );
          const usage = step.usage;
          const context = count(usage?.input_tokens) + count(usage?.cache_read_tokens);
          if (context > 0) payloads.push({ _tag: "ContextReported", tokens: context });
        }
        return payloads;
      }
      case "tool":
        return this.#tool(step, `${this.#sessionId ?? "agy"}:${this.#runs}:${index}`, done);
      default:
        // User input, checkpoints and kinds a newer version adds carry nothing canonical.
        return [];
    }
  }

  #delta(tag: "message" | "reasoning", messageId: string, text: string): ReadonlyArray<EventPayload> {
    const open = this.#text.get(messageId) ?? { tag, text: "" };
    open.text += text;
    this.#text.set(messageId, open);
    return [{ _tag: tag === "message" ? "MessageDelta" : "ReasoningDelta", messageId, text }];
  }

  #close(messageId: string): ReadonlyArray<EventPayload> {
    const open = this.#text.get(messageId);
    this.#text.delete(messageId);
    if (open === undefined || open.text.trim() === "") return [];
    return [
      {
        _tag: open.tag === "message" ? "MessageCompleted" : "ReasoningCompleted",
        messageId,
        text: open.text,
      },
    ];
  }

  #tool(step: AgyStep, callId: string, done: boolean): ReadonlyArray<EventPayload> {
    const payloads: Array<EventPayload> = [];
    let open = this.#tools.get(callId);
    if (open === undefined) {
      const native = step.tool_info?.name ?? step.tool_name ?? "tool";
      const described = describeTool(
        native,
        step.tool_info?.parameters,
        this.#options.mcpServers ?? [],
        this.#options.plugin,
      );
      open = { name: described.toolName, input: this.#absolute(described.input), native };
      this.#tools.set(callId, open);
      payloads.push({ _tag: "ToolCallStarted", callId, toolName: open.name, input: open.input });
    }
    if (!done) return payloads;
    this.#tools.delete(callId);
    const error = step.tool_info?.error;
    const failed = isRecord(error) && (typeof error.message === "string" || typeof error.type === "string");
    const output = failed
      ? (error.message ?? error.type ?? "The tool failed")
      : (step.tool_info?.output ?? "");
    payloads.push({ _tag: "ToolCallCompleted", callId, output, isError: failed });
    const path = open.input["path"];
    if (!failed && toolClass(open.native) === "edit" && typeof path === "string" && path !== "") {
      payloads.push({
        _tag: "FileChanged",
        path,
        change: open.native === "write_file" || open.native === "write_to_file" ? "created" : "modified",
      });
    }
    return payloads;
  }

  #absolute(input: Record<string, unknown>): Record<string, unknown> {
    const cwd = this.#options.cwd;
    const path = input["path"];
    if (cwd === undefined || typeof path !== "string" || path === "" || isAbsolute(path)) return input;
    return { ...input, path: resolve(cwd, path) };
  }

  #result(result: AgyResult): ReadonlyArray<EventPayload> {
    const usage = result.usage;
    const spent: Array<EventPayload> = [];
    if (usage !== undefined && count(usage.total_tokens) + count(usage.input_tokens) > 0) {
      const cached = count(usage.cache_read_tokens);
      spent.push({
        _tag: "UsageReported",
        inputTokens: Math.max(0, count(usage.input_tokens) - cached),
        outputTokens: count(usage.output_tokens) + count(usage.thinking_tokens),
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      });
    }
    // Antigravity's own policy refuses some actions without asking (headless soft-denies); say which.
    const denied = (result.denied_actions ?? []).flatMap(
      (action) => action.display_name ?? action.action ?? [],
    );
    const notice: ReadonlyArray<EventPayload> =
      denied.length === 0
        ? []
        : [
            {
              _tag: "AgentError",
              kind: "unknown",
              message: `Antigravity's own permission rules denied: ${denied.join(", ")}.`,
              retryable: false,
            },
          ];
    const status = result.status?.toUpperCase();
    if (
      result.finished_reason === "interrupted" ||
      status === "CANCELED" ||
      status === "CANCELLED" ||
      status === "INTERRUPTED"
    ) {
      return this.#endTurn("interrupted", [...spent, ...notice]);
    }
    if (status === "ERROR" || status === "INVALID" || result.finished_reason === "error") {
      return this.#endTurn("error", [
        ...spent,
        ...notice,
        errorPayload(result.error?.trim() || "Antigravity failed the turn"),
      ]);
    }
    if (result.finished_reason === "print_timeout") {
      return this.#endTurn("error", [
        ...spent,
        ...notice,
        {
          _tag: "AgentError",
          kind: "transient",
          message: "Antigravity's time limit ended the turn early.",
          retryable: true,
        },
      ]);
    }
    return this.#endTurn("completed", [...spent, ...notice]);
  }

  #endTurn(
    reason: "completed" | "interrupted" | "error",
    extra: ReadonlyArray<EventPayload>,
  ): ReadonlyArray<EventPayload> {
    if (!this.#inRun) return [];
    this.#inRun = false;
    const payloads: Array<EventPayload> = [];
    for (const messageId of [...this.#text.keys()]) payloads.push(...this.#close(messageId));
    for (const callId of this.#tools.keys()) {
      payloads.push({
        _tag: "ToolCallCompleted",
        callId,
        output: "The turn ended before this tool call finished.",
        isError: true,
      });
    }
    this.#tools.clear();
    payloads.push(...extra, { _tag: "TurnCompleted", stopReason: reason });
    return payloads;
  }
}
