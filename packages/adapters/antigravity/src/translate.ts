import type { EventPayload } from "@cerium/protocol";
import { randomUUID } from "node:crypto";

import { record, string } from "./acp.ts";
import { PROVIDER } from "./manifest.ts";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** ACP sends partial patches. Keep message blocks and tool lifetimes intact across them. */
export class AntigravityTranslator {
  private block: { id: string; text: string; reasoning: boolean } | undefined;
  private readonly tools = new Set<string>();
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
        if (content?.["type"] !== "text" || typeof content["text"] !== "string" || content["text"] === "")
          return [];
        const reasoning = update["sessionUpdate"] === "agent_thought_chunk";
        const previous = this.block?.reasoning === reasoning ? [] : this.finishBlock();
        const block = (this.block ??= { id: randomUUID(), text: "", reasoning });
        block.text += content["text"];
        return [
          ...previous,
          {
            _tag: reasoning ? "ReasoningDelta" : "MessageDelta",
            messageId: block.id,
            text: content["text"],
          },
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
            items: (Array.isArray(update["entries"]) ? update["entries"] : []).flatMap((entry: unknown) => {
              const item = record(entry);
              const text = string(item?.["content"]);
              return text === undefined
                ? []
                : [
                    {
                      text,
                      status:
                        item?.["status"] === "completed"
                          ? "completed"
                          : item?.["status"] === "in_progress"
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
    if (!this.tools.has(callId)) {
      const toolName = string(update["name"]) ?? string(update["kind"]) ?? string(update["title"]) ?? "Tool";
      this.tools.add(callId);
      events.push({
        _tag: "ToolCallStarted",
        callId,
        toolName,
        input: update["rawInput"] ?? update["args"] ?? {},
      });
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
    if (status === "completed" && Array.isArray(update["content"])) {
      for (const item of update["content"] as ReadonlyArray<unknown>) {
        const diff = record(item);
        const path = string(diff?.["path"]);
        if (diff?.["type"] === "diff" && path !== undefined) {
          events.push({
            _tag: "FileChanged",
            path,
            change: diff["oldText"] == null ? "created" : "modified",
          });
        }
      }
    }
    return events;
  }

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
        inputTokens: input,
        outputTokens: output,
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      });
    }
    return events;
  }
}
