import { Account } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import {
  MAX_NOTIFICATION_DETAIL,
  MAX_THREAD_TITLE,
  type AgentId,
  type AgentInfo,
  type NotificationKind,
  type ThreadId,
} from "@cerium/protocol";
import { Effect, FiberMap, Layer, Stream } from "effect";

// Push notifications (docs/architecture.md §14.11). This machine tells the relay when one of its
// threads waits on the user, finished or failed; the relay tells the account's browsers. A change
// settles before it's told, and is checked again then: a child handing its answer to the lead leaves
// the thread idle for a couple of seconds, and a request answered at once needs nobody told.

/** How long a thread's changes settle before they're told; longer than the lead's batch window (2s). */
const SETTLE_FOR = "4 seconds";

/** What a thread did since it was last told about. */
export interface Happened {
  /** The latest request it made of the user, in a line. */
  readonly asked?: string;
  /** An agent of it that failed. */
  readonly failed?: AgentId;
  /** One of its agents finished a turn. */
  readonly wentIdle?: boolean;
}

/** What an agent's last turn left, as its events said. */
export interface TurnEnd {
  readonly stopReason?: "completed" | "interrupted" | "maxTurns" | "error";
  readonly message?: string;
  readonly error?: string;
}

export interface Verdict {
  readonly kind: NotificationKind;
  readonly detail?: string;
}

/**
 * What to tell about a thread once its changes settled, given its agents now: a request still
 * waiting; else, with nothing working, a failure, or the lead done with a turn it wasn't stopped in.
 */
export const decide = (
  happened: Happened,
  agents: ReadonlyArray<AgentInfo>,
  awaitingApproval: boolean,
  turnEnd: (agentId: AgentId) => TurnEnd,
): Verdict | undefined => {
  const detail = (text: string | undefined) => (text === undefined ? {} : { detail: text });
  if (happened.asked !== undefined && awaitingApproval) return { kind: "needsYou", detail: happened.asked };
  if (awaitingApproval || agents.some((agent) => agent.state === "running" || agent.state === "queued"))
    return undefined;
  const failed = agents.find((agent) => agent.id === happened.failed && agent.state === "failed");
  if (failed !== undefined) return { kind: "failed", ...detail(turnEnd(failed.id).error) };
  const lead = agents.find((agent) => agent.parentId === undefined);
  if (!happened.wentIdle || lead?.state !== "idle") return undefined;
  const end = turnEnd(lead.id);
  if (end.stopReason === "interrupted") return undefined;
  if (end.stopReason === "error") return { kind: "failed", ...detail(end.error) };
  return { kind: "finished", ...detail(end.message) };
};

/** Markdown as one line of plain text, cut to fit a notification. */
export const notificationLine = (text: string): string | undefined => {
  const line = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return undefined;
  return line.length > MAX_NOTIFICATION_DETAIL
    ? `${line.slice(0, MAX_NOTIFICATION_DETAIL - 1).trimEnd()}…`
    : line;
};

/**
 * Tells the account's browsers about this machine's threads while it's signed in. Requires
 * `Account` and `Orchestrator`.
 */
export const Notifier = Layer.effectDiscard(
  Effect.gen(function* () {
    const account = yield* Account;
    const orchestrator = yield* Orchestrator;
    const settling = yield* FiberMap.make<ThreadId>();
    const happened = new Map<ThreadId, Happened>();
    const turnEnds = new Map<AgentId, TurnEnd>();
    const turnEnd = (agentId: AgentId) => turnEnds.get(agentId) ?? {};
    const endTurn = (agentId: AgentId, change: TurnEnd) =>
      turnEnds.set(agentId, { ...turnEnd(agentId), ...change });

    /** Tells the relay about a thread whose changes settled, if there's anything to tell. */
    const tell = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const changes = happened.get(threadId) ?? {};
        happened.delete(threadId);
        const agents = yield* orchestrator.listAgents(threadId);
        const verdict = decide(changes, agents, orchestrator.awaitingApproval(threadId), turnEnd);
        if (verdict === undefined) return;
        const thread = (yield* orchestrator.listThreads).find((each) => each.id === threadId);
        if (thread === undefined) return;
        const title = thread.title.slice(0, MAX_THREAD_TITLE);
        yield* account.send({ _tag: "Notify", threadId, title, ...verdict });
      }).pipe(Effect.ignore);

    const note = (threadId: ThreadId, change: Happened) =>
      Effect.gen(function* () {
        happened.set(threadId, { ...happened.get(threadId), ...change });
        // Each change restarts the wait, so a burst of them is told once.
        yield* FiberMap.run(settling, threadId, tell(threadId).pipe(Effect.delay(SETTLE_FOR)));
      });

    yield* orchestrator.events.pipe(
      Stream.runForEach(({ threadId, agentId, payload }) => {
        switch (payload._tag) {
          case "TurnInput":
            return Effect.sync(() => turnEnds.delete(agentId));
          case "MessageCompleted": {
            const message = notificationLine(payload.text);
            return Effect.sync(() => endTurn(agentId, message === undefined ? {} : { message }));
          }
          case "AgentError": {
            const error = notificationLine(payload.message);
            return Effect.sync(() => endTurn(agentId, error === undefined ? {} : { error }));
          }
          case "TurnCompleted":
            return Effect.sync(() => endTurn(agentId, { stopReason: payload.stopReason }));
          case "PermissionRequested":
            return note(threadId, { asked: notificationLine(payload.summary) ?? payload.toolName });
          case "SpawnApprovalRequested":
            return note(threadId, {
              asked: notificationLine(`Start a ${payload.role} agent on ${payload.model}`) ?? payload.role,
            });
          case "AgentStateChanged":
            if (payload.state === "failed") return note(threadId, { failed: agentId });
            if (payload.state === "idle") return note(threadId, { wentIdle: true });
            return Effect.void;
          default:
            return Effect.void;
        }
      }),
      Effect.forkScoped,
    );
  }),
);
