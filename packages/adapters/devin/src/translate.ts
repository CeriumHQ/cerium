import type { EventPayload, TodoItem } from "@cerium/protocol";
import { randomUUID } from "node:crypto";

import { array, record, string } from "./acp.ts";
import { PROVIDER } from "./manifest.ts";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Devin's own tool name (`exec`, `write`, `mcp__server__tool`), which ACP's `kind` only groups. */
export const toolName = (call: Readonly<Record<string, unknown>>) => {
  const meta = record(call["_meta"]);
  return (
    string(meta?.["cognition.ai/toolName"]) ??
    string(meta?.["cognition.ai/inferenceToolName"]) ??
    string(call["kind"]) ??
    string(call["title"]) ??
    "Tool"
  );
};

type FileChange = Extract<EventPayload, { _tag: "FileChanged" }>["change"];

/** ACP sends partial patches. Keep message blocks and tool lifetimes intact across them. */
export class DevinTranslator {
  private block: { id: string; text: string; reasoning: boolean } | undefined;
  private readonly tools = new Map<string, Map<string, FileChange>>();
  private readonly finishedTools = new Set<string>();

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
              if (text === undefined) return [];
              const status = item?.["status"];
              return [
                {
                  text,
                  status:
                    status === "completed"
                      ? "completed"
                      : status === "in_progress"
                        ? "inProgress"
                        : "pending",
                },
              ];
            }),
          },
        ];
      default:
        return [];
    }
  }

  private tool(update: Readonly<Record<string, unknown>>): ReadonlyArray<EventPayload> {
    const callId = string(update["toolCallId"]);
    if (callId === undefined || this.finishedTools.has(callId)) return [];
    const events = [...this.finishBlock()];
    let files = this.tools.get(callId);
    if (files === undefined) {
      files = new Map();
      this.tools.set(callId, files);
      events.push({
        _tag: "ToolCallStarted",
        callId,
        toolName: toolName(update),
        input: update["rawInput"] ?? {},
      });
    }
    // Devin shows a write's diff while it runs and reports only the status when it completes.
    for (const item of array(update["content"])) {
      const diff = record(item);
      const path = string(diff?.["path"]);
      if (diff?.["type"] === "diff" && path !== undefined) {
        files.set(
          path,
          diff["oldText"] == null ? "created" : diff["newText"] == null ? "deleted" : "modified",
        );
      }
    }
    const status = update["status"];
    if (status !== "completed" && status !== "failed") return events;
    this.tools.delete(callId);
    this.finishedTools.add(callId);
    events.push({
      _tag: "ToolCallCompleted",
      callId,
      output: update["rawOutput"] ?? update["content"] ?? null,
      isError: status === "failed",
    });
    if (status === "completed") {
      for (const [path, change] of files) events.push({ _tag: "FileChanged", path, change });
    }
    return events;
  }

  /** Closes what the turn left open and reports its usage, from the `session/prompt` result. */
  finish(result: unknown, model: string): ReadonlyArray<EventPayload> {
    const events = [...this.finishBlock()];
    for (const callId of this.tools.keys()) {
      events.push({ _tag: "ToolCallCompleted", callId, output: null, isError: true });
    }
    this.tools.clear();
    this.finishedTools.clear();
    const usage = record(record(result)?.["usage"]);
    const input = count(usage?.["inputTokens"]);
    const output = count(usage?.["outputTokens"]);
    const cached = count(usage?.["cachedReadTokens"]);
    if (input !== undefined && output !== undefined) {
      events.push({
        _tag: "UsageReported",
        provider: PROVIDER,
        model,
        // Devin's input count includes cache reads, which Cerium reports apart.
        inputTokens: Math.max(0, input - (cached ?? 0)),
        outputTokens: output,
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      });
    }
    return events;
  }
}
