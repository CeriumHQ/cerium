import { isStreamDelta, type AgentEvent, type AgentId, type HistoryCursor } from "@cerium/protocol";

/** A total display order, shared with the store's history cursor. */
export const byTime = (a: HistoryCursor, b: HistoryCursor) =>
  a.at - b.at || a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Late imports below an incomplete suffix wait for their older page, preserving fold context. */
export const inHistoryWindow = (event: AgentEvent, before: HistoryCursor | undefined, more: boolean) =>
  !more || before === undefined || byTime(event, before) >= 0;

export interface AgentHistory {
  readonly events: ReadonlyArray<AgentEvent>;
  /** Changes when history was inserted or rewritten, rather than appended. */
  readonly generation: number;
  readonly live: ReadonlyMap<string, AgentEvent>;
}
export interface ThreadHistory {
  readonly settled: ReadonlyArray<AgentEvent>;
  readonly agents: ReadonlyMap<AgentId, AgentHistory>;
  readonly more?: boolean;
  readonly loadOlder?: () => void;
  readonly loadThrough?: (cursor: HistoryCursor) => void;
  readonly pageRevision?: number;
  readonly loadError?: string | undefined;
}
interface AgentLog {
  events: Array<AgentEvent>;
  generation: number;
  dirty: boolean;
  unordered?: boolean;
  view?: AgentHistory | undefined;
}
interface Streaming {
  readonly first: AgentEvent;
  event: AgentEvent;
  readonly pending: Map<number, string>;
}
const blockOf = (event: AgentEvent): string | undefined => {
  const p = event.payload;
  if (p._tag === "MessageDelta" || p._tag === "MessageCompleted") return "message:" + p.messageId;
  if (p._tag === "ReasoningDelta" || p._tag === "ReasoningCompleted") return "reasoning:" + p.messageId;
  return undefined;
};
const keyOf = (event: AgentEvent, block: string) => event.agentId + "\n" + block;

/** Settled history and tiny live overlays. A word never copies or filters the settled log. */
export class ThreadLog {
  hasEvent(id: string): boolean {
    return this.#seen.has(id);
  }
  #events: Array<AgentEvent> = [];
  #settled: ReadonlyArray<AgentEvent> = [];
  #settledDirty = false;
  readonly #seen = new Set<string>();
  readonly #finished = new Set<string>();
  readonly #ended = new Map<AgentId, AgentEvent>();
  readonly #streaming = new Map<string, Streaming>();
  readonly #agents = new Map<AgentId, AgentLog>();
  #views = new Map<AgentId, AgentHistory>();

  #agent(id: AgentId): AgentLog {
    let log = this.#agents.get(id);
    if (log === undefined) {
      log = { events: [], generation: 0, dirty: true };
      this.#agents.set(id, log);
    }
    return log;
  }
  #append(event: AgentEvent) {
    const agent = this.#agent(event.agentId);
    if (agent.events.at(-1) !== undefined && byTime(agent.events.at(-1)!, event) > 0) {
      agent.events.push(event);
      agent.unordered = true;
      agent.generation++;
    } else agent.events.push(event);
    agent.dirty = true;
    this.#events.push(event);
    this.#settledDirty = true;
  }
  add(batch: Iterable<AgentEvent>): boolean {
    let changed = false;
    for (const event of batch) {
      const payload = event.payload;
      const block = blockOf(event);
      const key = block === undefined ? undefined : keyOf(event, block);
      if (
        isStreamDelta(payload._tag) &&
        (payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta")
      ) {
        const ended = this.#ended.get(event.agentId);
        if (key === undefined || this.#finished.has(key) || (ended && byTime(event, ended) <= 0)) continue;
        // Offset deltas deduplicate themselves. Legacy senders need their event ids remembered.
        if (payload.offset === undefined) {
          if (this.#seen.has(event.id)) continue;
          this.#seen.add(event.id);
        }
        let stream = this.#streaming.get(key);
        if (stream === undefined) {
          const first = { ...event, payload: { ...payload, text: "", offset: 0 } };
          stream = { first, event: first, pending: new Map() };
          this.#streaming.set(key, stream);
          this.#append(first);
          changed = true;
        }
        const held = stream.event.payload;
        if (held._tag !== "MessageDelta" && held._tag !== "ReasoningDelta") continue;
        let text = held.text;
        const offset = payload.offset ?? text.length;
        if (offset > text.length) stream.pending.set(offset, payload.text);
        else if (offset + payload.text.length > text.length) text = text.slice(0, offset) + payload.text;
        // A reconnect snapshot can fill a missing prefix before queued live deltas are consumed.
        for (const [at, part] of [...stream.pending].sort(([a], [b]) => a - b)) {
          if (at > text.length) break;
          if (at + part.length > text.length) text = text.slice(0, at) + part;
          stream.pending.delete(at);
        }
        if (text !== held.text) {
          stream.event = { ...stream.first, payload: { ...held, text, offset: 0 } };
          this.#agent(event.agentId).view = undefined;
          changed = true;
        }
        continue;
      }
      if (this.#seen.has(event.id)) continue;
      this.#seen.add(event.id);
      if (key !== undefined) {
        this.#finished.add(key);
        this.#streaming.delete(key);
        this.#agent(event.agentId).view = undefined;
      }
      // An interrupted stream has no completion. Keep its words when its turn ends.
      if (
        payload._tag === "TurnCompleted" ||
        payload._tag === "ConversationRewound" ||
        (payload._tag === "AgentStateChanged" && payload.state !== "running" && payload.state !== "queued")
      ) {
        const ended = this.#ended.get(event.agentId);
        if (!ended || byTime(event, ended) > 0) this.#ended.set(event.agentId, event);
        for (const [streamKey, stream] of this.#streaming) {
          // An older page may finish an earlier turn while the current one is still streaming.
          if (stream.first.agentId !== event.agentId || byTime(event, stream.first) < 0) continue;
          const agent = this.#agent(event.agentId);
          const replace = (events: Array<AgentEvent>) => {
            const index = events.indexOf(stream.first);
            if (index >= 0) events[index] = stream.event;
          };
          replace(agent.events);
          replace(this.#events);
          agent.generation++;
          agent.dirty = true;
          this.#settledDirty = true;
          this.#streaming.delete(streamKey);
          this.#finished.add(streamKey);
        }
      }
      this.#append(event);
      changed = true;
    }
    return changed;
  }
  /** Stable settled arrays and per-agent identities; only a changed agent gets a new view. */
  state(): ThreadHistory {
    if (this.#settledDirty) {
      this.#events.sort(byTime);
      this.#settled = this.#events.filter((event) => !isStreamDelta(event.payload._tag));
      this.#settledDirty = false;
    }
    let views = this.#views;
    for (const [id, agent] of this.#agents) {
      if (agent.dirty || agent.view === undefined) {
        if (agent.unordered) {
          agent.events.sort(byTime);
          agent.unordered = false;
        }
        if (views === this.#views) views = new Map(views);
        const live = new Map<string, AgentEvent>();
        for (const stream of this.#streaming.values()) {
          if (stream.first.agentId === id) live.set(blockOf(stream.first)!, stream.event);
        }
        agent.view = {
          events: agent.dirty ? agent.events.slice() : (views.get(id)?.events ?? []),
          generation: agent.generation,
          live,
        };
        agent.dirty = false;
        views.set(id, agent.view);
      }
    }
    this.#views = views;
    return { settled: this.#settled, agents: views };
  }
  /** Whole snapshots for tests / exports; UI readers use state, leaving live words separate. */
  snapshot(): ReadonlyArray<AgentEvent> {
    const live = new Map([...this.#streaming.values()].map((stream) => [stream.first.id, stream.event]));
    this.state();
    return this.#events.map((event) => live.get(event.id) ?? event);
  }
}
