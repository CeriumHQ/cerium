import type { EventPayload, TodoItem } from "@cerium/protocol";
import { randomUUID } from "node:crypto";

import { array, object, string } from "./rpc.ts";

export const toolName = (call: Readonly<Record<string, unknown>>) =>
  string(call["name"]) ??
  string(object(object(call["_meta"])?.["x.ai/tool"])?.["name"]) ??
  string(call["title"]) ??
  "Grok tool";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const usageFromPrompt = (result: unknown): EventPayload | undefined => {
  const meta = object(object(result)?.["_meta"]);
  const usage = object(meta?.["usage"]) ?? meta;
  const input = count(usage?.["inputTokens"]);
  const output = count(usage?.["outputTokens"]);
  const cached = count(usage?.["cachedReadTokens"]);
  if (input === undefined || output === undefined) return;
  const requestId = string(meta?.["requestId"]);
  const model = string(meta?.["modelId"]);
  return {
    _tag: "UsageReported",
    provider: "grok",
    ...(model === undefined ? {} : { model }),
    ...(requestId === undefined ? {} : { requestId }),
    inputTokens: Math.max(0, input - (cached ?? 0)),
    outputTokens: output,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
};

export class TurnUpdates {
  private block?: { readonly kind: "message" | "reasoning"; readonly id: string; text: string };
  private readonly tools = new Set<string>();
  private readonly completed = new Set<string>();

  private readonly emit: (payload: EventPayload) => void;

  constructor(emit: (payload: EventPayload) => void) {
    this.emit = emit;
  }

  flush() {
    const block = this.block;
    if (block === undefined) return;
    delete this.block;
    this.emit({
      _tag: block.kind === "message" ? "MessageCompleted" : "ReasoningCompleted",
      messageId: block.id,
      text: block.text,
    });
  }

  update(update: Readonly<Record<string, unknown>>) {
    switch (update["sessionUpdate"]) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = object(update["content"]);
        const text = content?.["type"] === "text" ? string(content["text"]) : undefined;
        if (text === undefined) return;
        const kind = update["sessionUpdate"] === "agent_message_chunk" ? "message" : "reasoning";
        if (this.block?.kind !== kind) {
          this.flush();
          this.block = { kind, id: randomUUID(), text: "" };
        }
        this.block.text += text;
        this.emit({
          _tag: kind === "message" ? "MessageDelta" : "ReasoningDelta",
          messageId: this.block.id,
          text,
        });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = string(update["toolCallId"]);
        if (callId === undefined || this.completed.has(callId)) return;
        if (!this.tools.has(callId)) {
          this.flush();
          this.tools.add(callId);
          this.emit({
            _tag: "ToolCallStarted",
            callId,
            toolName: toolName(update),
            input: update["rawInput"],
          });
        }
        const status = update["status"];
        if (status !== "completed" && status !== "failed") return;
        this.tools.delete(callId);
        this.completed.add(callId);
        const output = update["rawOutput"];
        const isError =
          status === "failed" ||
          (typeof object(output)?.["exit_code"] === "number" && object(output)?.["exit_code"] !== 0);
        this.emit({
          _tag: "ToolCallCompleted",
          callId,
          output: output ?? update["content"],
          isError,
        });
        if (isError) return;
        for (const entry of array(update["content"])) {
          const diff = object(entry);
          const path = string(diff?.["path"]);
          if (diff?.["type"] !== "diff" || path === undefined) continue;
          this.emit({
            _tag: "FileChanged",
            path,
            change: diff["oldText"] === null ? "created" : diff["newText"] === null ? "deleted" : "modified",
          });
        }
        break;
      }
      case "plan": {
        const items = array(update["entries"]).flatMap((entry): ReadonlyArray<TodoItem> => {
          const data = object(entry);
          if (typeof data?.["content"] !== "string") return [];
          const status = data["status"];
          return [
            {
              text: data["content"],
              status:
                status === "completed" ? "completed" : status === "in_progress" ? "inProgress" : "pending",
            },
          ];
        });
        this.emit({ _tag: "TodosUpdated", items });
        break;
      }
    }
  }
}
