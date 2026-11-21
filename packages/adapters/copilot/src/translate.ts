import type { CompletionUsage } from "@cerium/harness";
import type { BackgroundTask, EventPayload, TodoItem } from "@cerium/protocol";

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
    case "session.compaction_complete": {
      if (data["success"] !== true) {
        const reason = string(data["error"]) ?? string(data["failureReason"]);
        return [
          {
            _tag: "AgentError",
            kind: "unknown",
            message: `GitHub Copilot couldn't compact the conversation${reason ? `: ${reason}` : ""}`,
            retryable: false,
          },
        ];
      }
      const before = count(data["preCompactionTokens"]);
      const after = count(data["postCompactionTokens"]);
      const summary = string(data["summaryContent"])?.trim();
      return [
        {
          _tag: "ContextCompacted",
          trigger: data["trigger"] === "manual" ? "manual" : "auto",
          ...(before === undefined ? {} : { tokensBefore: before }),
          ...(after === undefined ? {} : { tokensAfter: after }),
          ...(summary ? { summary } : {}),
        },
      ];
    }
    case "session.error":
      return [translateError(data)];
    default:
      return [];
  }
};

/**
 * A row of the session's SQL `todos` table (`session.plan.readSqlTodos`) as a todo. Copilot's agent
 * writes `pending`, `in_progress`, `done` and `blocked`; a blocked item waits like a pending one.
 */
export const translateTodo = (row: unknown): ReadonlyArray<TodoItem> => {
  const todo = record(row);
  const text = string(todo?.["title"]) ?? string(todo?.["description"]);
  if (!todo || !text) return [];
  const id = string(todo["id"]);
  const status = string(todo["status"])?.toLowerCase();
  return [
    {
      ...(id ? { id } : {}),
      text,
      status:
        status === "done" || status === "completed"
          ? "completed"
          : status === "in_progress" || status === "inprogress"
            ? "inProgress"
            : status === "cancelled" || status === "canceled"
              ? "cancelled"
              : "pending",
    },
  ];
};

const time = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * A task of `session.tasks.list` that runs on in the background: a detached or backgrounded shell, a
 * backgrounded agent, or a task a client registered. Finished ones and ones the turn still waits on
 * are left out.
 */
export const translateTask = (value: unknown): ReadonlyArray<BackgroundTask> => {
  const task = record(value);
  const id = string(task?.["id"]);
  const status = task?.["status"];
  if (!task || !id || (status !== "running" && status !== "idle")) return [];
  const type = task["type"];
  // Client tasks always run in the background; the rest say how they run.
  if ((type === "shell" || type === "agent") && task["executionMode"] !== "background") return [];
  const command = type === "shell" ? string(task["command"]) : undefined;
  const description = string(task["description"]) ?? string(task["displayName"]) ?? command ?? id;
  const callId = string(task["toolCallId"]);
  const startedAt = time(task["startedAt"]);
  return [
    {
      id,
      kind: type === "shell" ? "command" : type === "agent" ? "agent" : "other",
      description,
      ...(command && command !== description ? { command } : {}),
      ...(callId ? { callId } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
      // `session.tasks.cancel` stops shells and agents; a client's task only while its owner listens.
      stoppable: type === "shell" || type === "agent" || task["canCancel"] === true,
    },
  ];
};
