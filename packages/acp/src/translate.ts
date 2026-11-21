import type { EventPayload, ProviderId, TodoItem } from "@cerium/protocol";
import { randomUUID } from "node:crypto";

import { array, count, record, string, type JsonRecord } from "./json.ts";

type FileChange = Extract<EventPayload, { _tag: "FileChanged" }>["change"];
type UsageReported = Extract<EventPayload, { _tag: "UsageReported" }>;

/** A tool call the turn started and hasn't finished. */
export interface OpenCall {
  readonly toolName: string;
  readonly title?: string;
  readonly input: unknown;
}

export interface UsageFields {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly requestId?: string;
  /** Holds `inputTokens`, `outputTokens` and `cachedReadTokens`, as ACP's `usage` names them. */
  readonly usage: unknown;
  /** The agent counts cache reads in `inputTokens`, which Cerium reports apart. */
  readonly inputIncludesCache?: boolean;
}

/** ACP's token counts as Cerium's `UsageReported`, or `undefined` when they are missing. */
export const usageReport = (fields: UsageFields): UsageReported | undefined => {
  const usage = record(fields.usage);
  const input = count(usage?.["inputTokens"]);
  const output = count(usage?.["outputTokens"]);
  const cached = count(usage?.["cachedReadTokens"]);
  if (input === undefined || output === undefined) return undefined;
  return {
    _tag: "UsageReported",
    provider: fields.provider,
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    inputTokens: fields.inputIncludesCache ? Math.max(0, input - (cached ?? 0)) : input,
    outputTokens: output,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
};

/** Where harnesses differ in how they fill ACP's tool-call and turn-result fields. */
export interface TranslatorDialect {
  readonly provider: ProviderId;
  /** The tool's own name. By default ACP's `name`, then its `kind`, then the call's title. */
  readonly toolName?: (call: JsonRecord) => string;
  /** By default `rawInput`. */
  readonly toolInput?: (call: JsonRecord) => unknown;
  /** By default `rawOutput`, then `content`. */
  readonly toolOutput?: (call: JsonRecord) => unknown;
  /** A completed call that failed all the same, such as a command's nonzero exit. */
  readonly toolFailed?: (call: JsonRecord) => boolean;
  /** The turn's usage from the `session/prompt` result. By default ACP's `usage`. */
  readonly usage?: (result: unknown, model: string) => UsageReported | undefined;
}

export const defaultToolName = (call: JsonRecord) =>
  string(call["name"]) ?? string(call["kind"]) ?? string(call["title"]) ?? "Tool";

const todoStatus = (status: unknown): TodoItem["status"] =>
  status === "completed" ? "completed" : status === "in_progress" ? "inProgress" : "pending";

/**
 * Turns ACP's `session/update` notifications into Cerium's events. ACP sends partial patches, so it
 * keeps message blocks and tool lifetimes intact across them; one translator serves one session, and
 * `finish` closes out each turn.
 */
export class AcpTranslator {
  private block: { id: string; text: string; reasoning: boolean } | undefined;
  private readonly open = new Map<string, OpenCall & { readonly files: Map<string, FileChange> }>();
  private readonly finished = new Set<string>();
  private readonly dialect: TranslatorDialect;

  constructor(dialect: TranslatorDialect) {
    this.dialect = dialect;
  }

  /** The call as it started, while it is running: what a permission request for it describes. */
  call(callId: string): OpenCall | undefined {
    const call = this.open.get(callId);
    if (call === undefined) return undefined;
    const { files: _files, ...started } = call;
    return started;
  }

  private finishBlock(): ReadonlyArray<EventPayload> {
    const block = this.block;
    this.block = undefined;
    return block === undefined
      ? []
      : [
          {
            _tag: block.reasoning ? "ReasoningCompleted" : "MessageCompleted",
            messageId: block.id,
            text: block.text,
          },
        ];
  }

  update(value: unknown): ReadonlyArray<EventPayload> {
    const update = record(value);
    if (update === undefined) return [];
    switch (update["sessionUpdate"]) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = record(update["content"]);
        const text = content?.["type"] === "text" ? string(content["text"]) : undefined;
        if (text === undefined) return [];
        const reasoning = update["sessionUpdate"] === "agent_thought_chunk";
        const previous = this.block?.reasoning === reasoning ? [] : this.finishBlock();
        const block = (this.block ??= { id: randomUUID(), text: "", reasoning });
        block.text += text;
        return [
          ...previous,
          { _tag: reasoning ? "ReasoningDelta" : "MessageDelta", messageId: block.id, text },
        ];
      }
      case "tool_call":
      case "tool_call_update":
        return this.tool(update);
      case "usage_update": {
        const tokens = count(update["used"]);
        const window = count(update["size"]);
        return tokens === undefined
          ? []
          : [
              {
                _tag: "ContextReported",
                tokens,
                ...(window === undefined || window === 0 ? {} : { window }),
              },
            ];
      }
      case "plan":
        return [
          {
            _tag: "TodosUpdated",
            items: array(update["entries"]).flatMap((entry): ReadonlyArray<TodoItem> => {
              const item = record(entry);
              const text = string(item?.["content"]);
              return text === undefined ? [] : [{ text, status: todoStatus(item?.["status"]) }];
            }),
          },
        ];
      default:
        return [];
    }
  }

  private tool(update: JsonRecord): ReadonlyArray<EventPayload> {
    const callId = string(update["toolCallId"]);
    if (callId === undefined || this.finished.has(callId)) return [];
    const events = [...this.finishBlock()];
    let call = this.open.get(callId);
    if (call === undefined) {
      const title = string(update["title"]);
      call = {
        toolName: (this.dialect.toolName ?? defaultToolName)(update),
        ...(title === undefined ? {} : { title }),
        input:
          this.dialect.toolInput === undefined ? (update["rawInput"] ?? {}) : this.dialect.toolInput(update),
        files: new Map(),
      };
      this.open.set(callId, call);
      events.push({ _tag: "ToolCallStarted", callId, toolName: call.toolName, input: call.input });
    }
    // Some agents show a write's diff while it runs and report only the status when it completes.
    for (const item of array(update["content"])) {
      const diff = record(item);
      const path = string(diff?.["path"]);
      if (diff?.["type"] === "diff" && path !== undefined) {
        call.files.set(
          path,
          diff["oldText"] == null ? "created" : diff["newText"] == null ? "deleted" : "modified",
        );
      }
    }
    const status = update["status"];
    if (status !== "completed" && status !== "failed") return events;
    this.open.delete(callId);
    this.finished.add(callId);
    const isError = status === "failed" || this.dialect.toolFailed?.(update) === true;
    events.push({
      _tag: "ToolCallCompleted",
      callId,
      output:
        this.dialect.toolOutput === undefined
          ? (update["rawOutput"] ?? update["content"] ?? null)
          : this.dialect.toolOutput(update),
      isError,
    });
    if (!isError) {
      for (const [path, change] of call.files) events.push({ _tag: "FileChanged", path, change });
    }
    return events;
  }

  /**
   * Closes what the turn left open (its last block, and as failed, any tool still running) and reports
   * its usage from the `session/prompt` result, if the turn has one.
   */
  finish(result: unknown, model: string): ReadonlyArray<EventPayload> {
    const events = [...this.finishBlock()];
    for (const callId of this.open.keys()) {
      events.push({ _tag: "ToolCallCompleted", callId, output: null, isError: true });
    }
    this.open.clear();
    this.finished.clear();
    if (result === undefined) return events;
    const usage =
      this.dialect.usage === undefined
        ? usageReport({ provider: this.dialect.provider, model, usage: record(result)?.["usage"] })
        : this.dialect.usage(result, model);
    if (usage !== undefined) events.push(usage);
    return events;
  }
}
