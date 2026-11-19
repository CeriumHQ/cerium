import type { CompletionUsage } from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";

import { LOGIN_COMMAND } from "./manifest.ts";
import { mcpToolName } from "./policy.ts";
import { record, string } from "./rpc.ts";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const translateUsage = (data: Record<string, unknown>): CompletionUsage | undefined => {
  const input = count(data["inputTokens"]);
  const output = count(data["outputTokens"]);
  if (input === undefined && output === undefined) return undefined;
  const cached = count(data["cacheReadTokens"]);
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0)),
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
};

export const translateError = (data: Record<string, unknown>): EventPayload => {
  const kind = data["errorType"];
  const message = string(data["message"]) ?? "GitHub Copilot CLI reported an error";
  switch (kind) {
    case "authentication":
      return {
        _tag: "AuthRequired",
        provider: "copilot",
        reason: "GitHub Copilot CLI needs you to sign in.",
        loginCommand: LOGIN_COMMAND,
      };
    case "quota":
      return { _tag: "LimitReached", provider: "copilot", message };
    case "rate_limit":
      return { _tag: "AgentError", kind: "rateLimit", message, retryable: true };
    default:
      return { _tag: "AgentError", kind: "unknown", message, retryable: false };
  }
};

export const translateEvent = (
  event: Record<string, unknown>,
  data: Record<string, unknown>,
): ReadonlyArray<EventPayload> => {
  const messageId = string(data["messageId"]) ?? string(event["id"]);
  const callId = string(data["toolCallId"]);
  switch (event["type"]) {
    case "assistant.message_delta": {
      const text = string(data["deltaContent"]);
      return messageId && text ? [{ _tag: "MessageDelta", messageId, text }] : [];
    }
    case "assistant.message": {
      const text = string(data["content"]);
      return messageId && text ? [{ _tag: "MessageCompleted", messageId, text }] : [];
    }
    case "assistant.reasoning_delta": {
      const id = string(data["reasoningId"]);
      const text = string(data["deltaContent"]);
      return id && text ? [{ _tag: "ReasoningDelta", messageId: id, text }] : [];
    }
    case "assistant.reasoning": {
      const id = string(data["reasoningId"]) ?? messageId;
      const text = string(data["content"]);
      return id && text ? [{ _tag: "ReasoningCompleted", messageId: id, text }] : [];
    }
    case "tool.execution_start": {
      const server = string(data["mcpConfigServerName"]) ?? string(data["mcpServerName"]);
      const mcpTool = string(data["mcpToolName"]);
      const toolName = server && mcpTool ? mcpToolName(server, mcpTool) : string(data["toolName"]);
      return callId && toolName
        ? [{ _tag: "ToolCallStarted", callId, toolName, input: data["arguments"] }]
        : [];
    }
    case "tool.execution_complete": {
      if (!callId) return [];
      const result = record(data["result"]);
      const payloads: Array<EventPayload> = [
        {
          _tag: "ToolCallCompleted",
          callId,
          isError: data["success"] === false,
          output: result?.["detailedContent"] ?? result?.["content"] ?? data["error"] ?? data["result"],
        },
      ];
      if (Array.isArray(data["fileEdits"])) {
        for (const edit of data["fileEdits"]) {
          const path = string(record(edit)?.["path"]);
          const kind = record(edit)?.["kind"];
          if (path)
            payloads.push({
              _tag: "FileChanged",
              path,
              change: kind === "create" ? "created" : kind === "delete" ? "deleted" : "modified",
            });
        }
      }
      return payloads;
    }
    case "session.usage_info": {
      const tokens = count(data["currentTokens"]);
      const window = count(data["tokenLimit"]);
      return tokens === undefined
        ? []
        : [
            {
              _tag: "ContextReported",
              tokens,
              ...(window ? { window } : {}),
            },
          ];
    }
    case "session.error":
      return [translateError(data)];
    default:
      return [];
  }
};
