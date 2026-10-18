import type { AccessMode, AgentEvent, Attachment, InputItem, Mention, ProviderId } from "@cerium/protocol";

// The transcript is a pure fold over one agent's canonical events. Streaming deltas grow a block
// until its completed event replaces the text, so live and replayed threads render identically.

export type TranscriptBlock =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      readonly mentions: ReadonlyArray<Mention>;
    }
  | { readonly kind: "notice"; readonly id: string; readonly item: Exclude<InputItem, { _tag: "FromUser" }> }
  | { readonly kind: "message"; readonly id: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly streaming: boolean }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output?: unknown;
      readonly status: "running" | "done" | "error";
      readonly changedFiles: ReadonlyArray<string>;
    }
  | {
      readonly kind: "spawn";
      readonly id: string;
      readonly childId: string;
      readonly role: string;
      readonly provider: ProviderId;
      readonly model: string;
      readonly access: AccessMode;
    }
  | {
      readonly kind: "permission";
      readonly id: string;
      readonly toolName: string;
      readonly summary: string;
      readonly input: unknown;
      readonly resolution?: { readonly decision: "allow" | "deny"; readonly scope: "once" | "session" };
    }
  | {
      readonly kind: "turnEnd";
      readonly id: string;
      readonly stopReason: string;
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly costUsd?: number;
      };
    }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

/** Whether the agent is mid-turn, waiting for input, or gone for good (stopped or failed). */
export type AgentActivity = "running" | "idle" | "ended";

export const buildTranscript = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<TranscriptBlock> => {
  const blocks: Array<TranscriptBlock> = [];
  const indexOf = new Map<string, number>();
  let lastUsage: Extract<TranscriptBlock, { kind: "turnEnd" }>["usage"];

  const upsert = (key: string, block: TranscriptBlock) => {
    const index = indexOf.get(key);
    if (index === undefined) {
      indexOf.set(key, blocks.length);
      blocks.push(block);
    } else {
      blocks[index] = block;
    }
  };
  const existing = <K extends TranscriptBlock["kind"]>(key: string, kind: K) => {
    const index = indexOf.get(key);
    const block = index === undefined ? undefined : blocks[index];
    return block?.kind === kind ? (block as Extract<TranscriptBlock, { kind: K }>) : undefined;
  };

  for (const { payload, id } of events) {
    switch (payload._tag) {
      case "TurnInput":
        payload.items.forEach((item, index) => {
          const key = `${id}:${index}`;
          blocks.push(
            item._tag === "FromUser"
              ? {
                  kind: "user",
                  id: key,
                  text: item.text,
                  attachments: item.attachments ?? [],
                  mentions: item.mentions ?? [],
                }
              : { kind: "notice", id: key, item },
          );
        });
        break;
      case "MessageDelta": {
        const key = `message:${payload.messageId}`;
        const text = (existing(key, "message")?.text ?? "") + payload.text;
        upsert(key, { kind: "message", id: key, text, streaming: true });
        break;
      }
      case "MessageCompleted": {
        const key = `message:${payload.messageId}`;
        upsert(key, { kind: "message", id: key, text: payload.text, streaming: false });
        break;
      }
      case "ReasoningDelta": {
        const key = `reasoning:${payload.messageId}`;
        const text = (existing(key, "reasoning")?.text ?? "") + payload.text;
        upsert(key, { kind: "reasoning", id: key, text, streaming: true });
        break;
      }
      case "ReasoningCompleted": {
        const key = `reasoning:${payload.messageId}`;
        upsert(key, { kind: "reasoning", id: key, text: payload.text, streaming: false });
        break;
      }
      case "ToolCallStarted": {
        const key = `tool:${payload.callId}`;
        upsert(key, {
          kind: "tool",
          id: key,
          toolName: payload.toolName,
          input: payload.input,
          status: "running",
          changedFiles: [],
        });
        break;
      }
      case "ToolCallCompleted": {
        const key = `tool:${payload.callId}`;
        const started = existing(key, "tool");
        if (started !== undefined) {
          upsert(key, { ...started, output: payload.output, status: payload.isError ? "error" : "done" });
        }
        break;
      }
      case "FileChanged": {
        // Attribute the change to the most recent tool call.
        for (let index = blocks.length - 1; index >= 0; index--) {
          const block = blocks[index];
          if (block?.kind === "tool") {
            blocks[index] = { ...block, changedFiles: [...block.changedFiles, payload.path] };
            break;
          }
        }
        break;
      }
      case "AgentSpawned":
        blocks.push({
          kind: "spawn",
          id: `spawn:${payload.childId}`,
          childId: payload.childId,
          role: payload.role,
          provider: payload.provider,
          model: payload.model,
          access: payload.access,
        });
        break;
      case "PermissionRequested":
        upsert(`permission:${payload.requestId}`, {
          kind: "permission",
          id: `permission:${payload.requestId}`,
          toolName: payload.toolName,
          summary: payload.summary,
          input: payload.input,
        });
        break;
      case "PermissionResolved": {
        const key = `permission:${payload.requestId}`;
        const request = existing(key, "permission");
        if (request !== undefined) {
          upsert(key, { ...request, resolution: { decision: payload.decision, scope: payload.scope } });
        }
        break;
      }
      case "UsageReported":
        lastUsage = {
          inputTokens: payload.inputTokens + (payload.cachedInputTokens ?? 0),
          outputTokens: payload.outputTokens,
          ...(payload.costUsd === undefined ? {} : { costUsd: payload.costUsd }),
        };
        break;
      case "TurnCompleted":
        blocks.push({
          kind: "turnEnd",
          id: `turnEnd:${id}`,
          stopReason: payload.stopReason,
          ...(lastUsage ? { usage: lastUsage } : {}),
        });
        lastUsage = undefined;
        break;
      case "AgentError":
        blocks.push({ kind: "error", id: `error:${id}`, message: payload.message });
        break;
      default:
        break;
    }
  }
  return blocks;
};
