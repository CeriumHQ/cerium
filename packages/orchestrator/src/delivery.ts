import type { AgentId, ThreadId } from "@cerium/protocol";

export interface MessageOptions {
  readonly kind?: "note" | "request" | "reply";
  readonly requestId?: string;
  /** Compatibility with agents running before explicit message kinds. */
  readonly reply?: boolean;
}

interface Request {
  readonly id: string;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly task: boolean;
  readonly legacy?: boolean;
  readonly group?: string | undefined;
}

/** Correlates replies and bounds unsolicited wake chains; it never drops an input. */
export class MessageDelivery {
  readonly requests = new Map<string, Request>();
  readonly #wakes = new Map<ThreadId, number>();

  request(request: Request): void {
    this.requests.set(request.id, request);
  }

  answer(from: AgentId, to: AgentId, id: string): boolean {
    const request = this.requests.get(id);
    if (request?.from !== to || request.to !== from) return false;
    this.requests.delete(id);
    return true;
  }

  legacyReply(from: AgentId, to: AgentId): string | undefined {
    return [...this.requests.values()].find((r) => r.legacy && r.from === to && r.to === from)?.id;
  }

  taskFor(child: AgentId): Request | undefined {
    return [...this.requests.values()].find((r) => r.task && r.to === child);
  }

  activeTasks(child: AgentId, active: ReadonlySet<string>): readonly Request[] {
    return [...this.requests.values()].filter((r) => r.task && r.to === child && active.has(r.id));
  }

  waiting(agent: AgentId): boolean {
    return [...this.requests.values()].some((r) => r.from === agent && !r.task);
  }

  groupPending(request: Request): boolean {
    return (
      request.group !== undefined &&
      [...this.requests.values()].some((r) => r.task && r.from === request.from && r.group === request.group)
    );
  }

  takeWake(thread: ThreadId, limit: number): boolean {
    const count = this.#wakes.get(thread) ?? 0;
    if (count >= limit) return false;
    this.#wakes.set(thread, count + 1);
    return true;
  }

  userTurn(thread: ThreadId): void {
    this.#wakes.delete(thread);
  }

  remove(agent: AgentId): void {
    for (const [id, request] of this.requests) {
      if (request.from === agent || request.to === agent) this.requests.delete(id);
    }
  }
}
