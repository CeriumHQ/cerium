import type {
  AccessMode,
  AgentEvent,
  Attachment,
  ContextCompacted,
  EffortRouted,
  FromUser,
  InputItem,
  Mention,
  ProviderId,
  Question,
  QuestionAnswer,
  ReasoningEffort,
  TurnFile,
} from "@cerium/protocol";

/** The `RPC_VERSION` that brought `EditMessage`; an older machine's messages can't be edited. */
export const EDIT_VERSION = 11;

/** The `RPC_VERSION` that brought `SteerAgent`; an older machine's queued messages wait for the turn's end. */
export const STEER_VERSION = 19;

/** The `RPC_VERSION` that brought `WithdrawMessage`; an older machine's queued messages can't be taken back. */
export const WITHDRAW_VERSION = 26;

// The transcript is a pure fold over one agent's canonical events. Streaming deltas grow a block
// until its completed event replaces the text, so live and replayed threads render identically.

export type TranscriptBlock =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      readonly mentions: ReadonlyArray<Mention>;
      /** The title of the thread whose lead wrote this for the user when it started this thread. */
      readonly writtenIn?: string;
      /** Whether the message reached the agent, so the user can edit it and send it again. */
      readonly delivered?: true;
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
  /** Questions the agent put to the user with `ask_user`, open until answered, dismissed or expired. */
  | {
      readonly kind: "question";
      readonly id: string;
      readonly requestId: string;
      readonly questions: ReadonlyArray<Question>;
      /** When the agent asked. */
      readonly at: number;
      readonly resolution?: QuestionResolution;
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
      /** The files the turn changed, once its snapshot after it is in. */
      readonly changes?: TurnChanges;
    }
  | { readonly kind: "error"; readonly id: string; readonly message: string }
  /**
   * Where the harness compacted the conversation, on its own or because the user asked, with its
   * size before and after and the summary it kept, as far as the harness says.
   */
  | ({ readonly kind: "compacted"; readonly id: string } & Omit<ContextCompacted, "_tag">)
  /** The thread came from a session the user had with the harness outside Cerium. */
  | {
      readonly kind: "imported";
      readonly id: string;
      readonly provider: ProviderId;
      /** The harness couldn't give the session's history; `detail` says why. */
      readonly unavailable?: { readonly detail?: string };
    }
  /** What the effort router decided for the turn about to start, for an agent on Auto. */
  | { readonly kind: "routed"; readonly id: string; readonly decision: RoutedDecision }
  /**
   * The model the agent runs on from here: where its session starts, where the user switches it to
   * another model or effort, and where they hand it to another harness. Responses are labelled with
   * the one in effect when they began.
   */
  | {
      readonly kind: "model";
      readonly id: string;
      /** The harness it runs on, where the thread said: a session's start and a handoff do. */
      readonly provider?: ProviderId;
      readonly model: string;
      readonly effort?: ReasoningEffort;
      /** `start` is a session beginning, which says nothing; the others are the user's switches. */
      readonly change: "start" | "model" | "effort" | "handoff";
    }
  /**
   * What the conversation went back on: the turns from one of the user's messages on, which the user
   * edited and sent again (or restored to before), kept to look back on.
   */
  | {
      readonly kind: "replaced";
      readonly id: string;
      readonly blocks: ReadonlyArray<TranscriptBlock>;
      /** The files a restore put back as they were before these turns. */
      readonly files?: number;
    };

/** What the effort router decided for one turn. */
export type RoutedDecision = Omit<EffortRouted, "_tag">;

export type UserBlock = Extract<TranscriptBlock, { kind: "user" }>;

/** The files one turn changed, which its response lists, and whether the user undid them. */
export interface TurnChanges {
  readonly turnId: string;
  /** The folder's snapshots from before and after the turn, which a file's diff compares. */
  readonly before: string;
  readonly after: string;
  readonly files: ReadonlyArray<TurnFile>;
  /** Files it changed past those listed. */
  readonly more: number;
  /** The user put them back as they were before the turn; `kept` had changed since, and stayed. */
  readonly undone?: { readonly kept: ReadonlyArray<string> };
}

/** How a question closed; `answers` holds one per question when the user answered. */
export interface QuestionResolution {
  readonly outcome: "answered" | "dismissed" | "expired";
  readonly answers?: ReadonlyArray<QuestionAnswer>;
}

/** The notice that hands an agent the user's answer, which the question itself shows. */
export const isAnswerNotice = (block: TranscriptBlock): boolean =>
  block.kind === "notice" && block.item._tag === "SystemNotice" && block.item.questionId !== undefined;

const userBlock = (item: FromUser, id: string): UserBlock => ({
  kind: "user",
  id,
  text: item.text,
  attachments: item.attachments ?? [],
  mentions: item.mentions ?? [],
  ...(item.writtenBy ? { writtenIn: item.writtenBy.threadTitle } : {}),
});

/**
 * A streamed block's text with a delta in it, or undefined when the delta adds nothing. A delta that
 * says where it starts adds only what the text lacks, so the text streamed so far, which a thread
 * read mid-reply starts with, and deltas already held overlap without repeating; one past the text's
 * end, after deltas the window missed, waits for the read that follows a reconnect to fill the gap.
 * A delta without an offset, from an older machine, is appended.
 */
const withDelta = (held: string | undefined, delta: { readonly text: string; readonly offset?: number }) => {
  const text = held ?? "";
  if (delta.offset === undefined) return text + delta.text;
  if (delta.offset > text.length || delta.offset + delta.text.length <= text.length) return undefined;
  return text.slice(0, delta.offset) + delta.text;
};

/** Whether the agent is mid-turn, waiting for input, or gone for good (stopped or failed). */
export type AgentActivity = "running" | "idle" | "ended";

/**
 * `sameModel` tells whether two of the agent's model ids are one model: a session reports the id it
 * resolved to (`claude-opus-5-5`), a switch the id it was picked by (`opus`).
 */
export const buildTranscript = (
  events: ReadonlyArray<AgentEvent>,
  sameModel: (a: string, b: string) => boolean = (a, b) => a === b,
): ReadonlyArray<TranscriptBlock> => {
  const blocks: Array<TranscriptBlock> = [];
  const indexOf = new Map<string, number>();
  let lastUsage: Extract<TranscriptBlock, { kind: "turnEnd" }>["usage"];
  let running: { model: string; effort: ReasoningEffort | undefined; provider?: ProviderId } | undefined;
  /** The turn in progress, by the id its files are recorded under. */
  let turnId: string | undefined;
  /**
   * A turn took input since the last ended. One that took none and compacted, or failed to, is a
   * compaction the user asked for: it has no response for a footer to end.
   */
  let answering = false;
  let compacting = false;

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

  /** Where each event's blocks begin, for a rewind to find what it replaced. */
  const startOf: Array<{ readonly sequence: number; readonly index: number }> = [];

  for (const { payload, id, sequence, at } of events) {
    startOf.push({ sequence, index: blocks.length });
    switch (payload._tag) {
      case "ConversationRewound": {
        const start = startOf.find((entry) => entry.sequence >= payload.fromSequence)?.index ?? blocks.length;
        const replaced = blocks.splice(start);
        for (const [key, index] of indexOf) if (index >= start) indexOf.delete(key);
        if (replaced.length > 0) blocks.push({ kind: "replaced", id: `replaced:${id}`, blocks: replaced });
        lastUsage = undefined;
        break;
      }
      // A restore's files follow the rewind of its conversation.
      case "FilesRestored": {
        const index = blocks.findLastIndex((block) => block.kind === "replaced");
        const block = blocks[index];
        if (block?.kind === "replaced" && payload.paths.length > 0) {
          blocks[index] = { ...block, files: payload.paths.length };
        }
        break;
      }
      case "SessionImported":
        blocks.push({
          kind: "imported",
          id: `imported:${id}`,
          provider: payload.provider,
          ...(payload.history === "unavailable"
            ? { unavailable: payload.detail === undefined ? {} : { detail: payload.detail } }
            : {}),
        });
        break;
      case "SessionStarted":
      case "ModelChanged":
      case "LeadHandedOff": {
        const effort = payload.effort;
        const change =
          payload._tag === "SessionStarted"
            ? "start"
            : payload._tag === "LeadHandedOff"
              ? "handoff"
              : running === undefined || !sameModel(running.model, payload.model)
                ? "model"
                : running.effort !== effort
                  ? "effort"
                  : undefined;
        const provider = payload._tag === "ModelChanged" ? running?.provider : payload.provider;
        running = { model: payload.model, effort, ...(provider ? { provider } : {}) };
        // A switch to what the agent already ran on changes nothing to show.
        if (change === undefined || (change === "effort" && effort === undefined)) break;
        blocks.push({
          kind: "model",
          id: `model:${id}`,
          ...(provider ? { provider } : {}),
          model: payload.model,
          ...(effort ? { effort } : {}),
          change,
        });
        break;
      }
      // A routed level is the one the agent runs at from here, so a later switch to it is no change.
      case "EffortRouted": {
        const { _tag, ...decision } = payload;
        blocks.push({ kind: "routed", id: `routed:${id}`, decision });
        if (running !== undefined && payload.effort !== undefined) {
          running = { ...running, effort: payload.effort };
        }
        break;
      }
      case "TurnInput":
        turnId = payload.turnId;
        answering = true;
        payload.items.forEach((item, index) => {
          const key = `${id}:${index}`;
          // A message keeps the key it had while queued.
          blocks.push(
            item._tag === "FromUser"
              ? { ...userBlock(item, item.id ?? key), ...(item.id ? { delivered: true as const } : {}) }
              : { kind: "notice", id: key, item },
          );
        });
        break;
      case "MessageDelta": {
        const key = `message:${payload.messageId}`;
        const text = withDelta(existing(key, "message")?.text, payload);
        if (text !== undefined) upsert(key, { kind: "message", id: key, text, streaming: true });
        break;
      }
      case "MessageCompleted": {
        const key = `message:${payload.messageId}`;
        upsert(key, { kind: "message", id: key, text: payload.text, streaming: false });
        break;
      }
      case "ReasoningDelta": {
        const key = `reasoning:${payload.messageId}`;
        const text = withDelta(existing(key, "reasoning")?.text, payload);
        if (text !== undefined) upsert(key, { kind: "reasoning", id: key, text, streaming: true });
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
      case "QuestionAsked":
        upsert(`question:${payload.requestId}`, {
          kind: "question",
          id: `question:${payload.requestId}`,
          requestId: payload.requestId,
          questions: payload.questions,
          at,
        });
        break;
      case "QuestionResolved": {
        const key = `question:${payload.requestId}`;
        const asked = existing(key, "question");
        if (asked !== undefined) {
          upsert(key, {
            ...asked,
            resolution: {
              outcome: payload.outcome,
              ...(payload.answers ? { answers: payload.answers } : {}),
            },
          });
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
      case "ContextCompacted": {
        const { _tag, ...compaction } = payload;
        blocks.push({ kind: "compacted", id: `compacted:${id}`, ...compaction });
        if (!answering) compacting = true;
        break;
      }
      case "TurnCompleted":
        if (!answering && compacting) {
          compacting = false;
          lastUsage = undefined;
          break;
        }
        answering = false;
        compacting = false;
        // Its files arrive after it, named by the turn's id.
        if (turnId !== undefined) indexOf.set(`turn:${turnId}`, blocks.length);
        blocks.push({
          kind: "turnEnd",
          id: `turnEnd:${id}`,
          stopReason: payload.stopReason,
          ...(lastUsage ? { usage: lastUsage } : {}),
        });
        lastUsage = undefined;
        break;
      case "TurnFilesChanged": {
        const key = `turn:${payload.turnId}`;
        const end = existing(key, "turnEnd");
        if (end !== undefined) {
          const { turnId: changedIn, before, after, files } = payload;
          upsert(key, {
            ...end,
            changes: { turnId: changedIn, before, after, files, more: payload.more ?? 0 },
          });
        }
        break;
      }
      case "TurnFilesReverted": {
        const key = `turn:${payload.turnId}`;
        const end = existing(key, "turnEnd");
        if (end?.changes !== undefined) {
          const { undone: _was, ...changes } = end.changes;
          upsert(key, {
            ...end,
            changes:
              payload.direction === "undone" ? { ...changes, undone: { kept: payload.kept } } : changes,
          });
        }
        break;
      }
      case "AgentError":
        blocks.push({ kind: "error", id: `error:${id}`, message: payload.message });
        if (!answering) compacting = true;
        break;
      default:
        break;
    }
  }
  return blocks;
};

/** The user's messages Cerium took but hasn't delivered, and whether they wait behind a running turn. */
export interface QueuedMessages {
  readonly messages: ReadonlyArray<UserBlock>;
  /** Otherwise they wait for the agent's session to start, or for its next one. */
  readonly behindTurn: boolean;
}

export const queuedMessages = (events: ReadonlyArray<AgentEvent>): QueuedMessages => {
  const queued = new Map<string, UserBlock>();
  let turnOpen = false;
  for (const { payload } of events) {
    switch (payload._tag) {
      case "MessageQueued":
        if (payload.message.id !== undefined) {
          queued.set(payload.message.id, userBlock(payload.message, payload.message.id));
        }
        break;
      case "TurnInput":
        turnOpen = true;
        for (const item of payload.items) if (item._tag === "FromUser" && item.id) queued.delete(item.id);
        break;
      case "TurnCompleted":
        turnOpen = false;
        break;
      case "MessageWithdrawn":
        queued.delete(payload.messageId);
        break;
      // Every message queued before a rewind went with the turns it replaced.
      case "ConversationRewound":
        queued.clear();
        turnOpen = false;
        break;
      default:
        break;
    }
  }
  return { messages: [...queued.values()], behindTurn: turnOpen };
};

/**
 * Whether queued messages wait in the message box rather than read as sent: behind a running turn,
 * or for an ended agent to start again. Ones waiting only for the session to start read as sent.
 */
export const holdsQueue = (queued: QueuedMessages, activity: AgentActivity): boolean =>
  queued.messages.length > 0 && (activity === "ended" || (activity === "running" && queued.behindTurn));
