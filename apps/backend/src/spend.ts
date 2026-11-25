import type {
  AgentId,
  AgentInfo,
  AgentSpend,
  ComboSpend,
  ModelSpeed,
  ModelSpend,
  ProviderId,
  ReasoningEffort,
  SpendBucket,
  SpendReport,
  SpendTotals,
  ThreadInfo,
  ThreadSpend,
} from "@cerium/protocol";
import type { SpendEvent } from "@cerium/store";

/** How many of the biggest threads and agents a report lists. */
export const SPEND_ROWS = 50;

const noSpend = (): SpendTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  turns: 0,
  pricedTurns: 0,
  costUsd: 0,
});

const add = (total: SpendTotals, turn: SpendEvent): SpendTotals => ({
  inputTokens: total.inputTokens + (turn.inputTokens ?? 0),
  outputTokens: total.outputTokens + (turn.outputTokens ?? 0),
  cachedInputTokens: total.cachedInputTokens + (turn.cachedInputTokens ?? 0),
  turns: total.turns + 1,
  pricedTurns: total.pricedTurns + (turn.costUsd === undefined ? 0 : 1),
  costUsd: total.costUsd + (turn.costUsd ?? 0),
});

const tokensOf = (total: SpendTotals) => total.inputTokens + total.outputTokens + total.cachedInputTokens;

/** A group of totals keyed by anything that can be told apart by a string. */
class Groups<Key> {
  readonly #totals = new Map<string, { key: Key; total: SpendTotals }>();
  readonly #id: (key: Key) => string;

  constructor(id: (key: Key) => string) {
    this.#id = id;
  }

  add(key: Key, turn: SpendEvent) {
    const id = this.#id(key);
    const entry = this.#totals.get(id) ?? { key, total: noSpend() };
    this.#totals.set(id, { key, total: add(entry.total, turn) });
  }

  /** The groups with the most tokens first. */
  get rows(): Array<{ key: Key; total: SpendTotals }> {
    return [...this.#totals.values()].toSorted((a, b) => tokensOf(b.total) - tokensOf(a.total));
  }
}

interface ComboKey {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: ReasoningEffort | undefined;
  readonly speed: ModelSpeed | undefined;
}

/**
 * What each turn ran with: model, effort and speed. A switch applies from the agent's next turn, so
 * `ModelChanged` waits for the `TurnInput` that starts it — its absent effort or speed is the model
 * having no setting for it, not "unchanged". A session starts on the model it names; not every
 * adapter records its effort, so only a present one reads. The effort router's word (`EffortRouted`)
 * is the level the turn about to start runs at, a pending switch applied — absent, the harness's own
 * — and holds until routing or a switch says again. Events given for an agent in the order they
 * happened. For what an agent's events never say, such as one from before sessions named their
 * model, its current setup stands in.
 */
const combosOf = (events: ReadonlyArray<SpendEvent>, agents: ReadonlyMap<AgentId, AgentInfo>) => {
  const turns: Array<{ turn: SpendEvent } & ComboKey> = [];
  type Setup = {
    model: string | undefined;
    effort: ReasoningEffort | undefined;
    speed: ModelSpeed | undefined;
  };
  let current:
    | (Setup & { agentId: AgentId; provider: ProviderId | undefined; pending: Setup | undefined })
    | undefined;
  for (const event of events) {
    if (current?.agentId !== event.agentId) {
      // The agent's current effort and speed hold until its events say otherwise, absent included.
      const agent = agents.get(event.agentId);
      current = {
        agentId: event.agentId,
        model: undefined,
        provider: undefined,
        effort: agent?.effort,
        speed: agent?.speed,
        pending: undefined,
      };
    }
    switch (event.tag) {
      case "SessionStarted":
        current.model = event.model;
        current.provider = event.provider;
        if (event.effort !== undefined) current.effort = event.effort;
        current.pending = undefined;
        break;
      case "ModelChanged":
        current.pending = { model: event.model, effort: event.effort, speed: event.speed };
        break;
      case "EffortRouted":
        // Recorded once a pending switch is applied, so it overrides the switch's effort.
        if (current.pending === undefined) current.effort = event.effort;
        else current.pending = { ...current.pending, effort: event.effort };
        break;
      case "TurnInput":
        if (current.pending !== undefined) {
          current.model = current.pending.model ?? current.model;
          current.effort = current.pending.effort;
          current.speed = current.pending.speed;
          current.pending = undefined;
        }
        break;
      case "UsageReported": {
        const agent = agents.get(event.agentId);
        const model = event.model ?? current.model ?? agent?.model;
        const provider = event.provider ?? current.provider ?? agent?.provider;
        if (model === undefined || provider === undefined) break;
        turns.push({ turn: event, model, provider, effort: current.effort, speed: current.speed });
      }
    }
  }
  return turns;
};

/**
 * What the agents used between the first and last of `edges`, summed from their turns' reported
 * usage: in total, in each bucket between two edges, and by harness, model, combo of model, effort
 * and speed, thread and agent. `events` are `Store.listSpendEvents` for that span. Turns that
 * reported nothing are not counted.
 */
export const spendReport = (input: {
  readonly events: ReadonlyArray<SpendEvent>;
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly threads: ReadonlyArray<ThreadInfo>;
  readonly edges: ReadonlyArray<number>;
}): SpendReport => {
  const { edges } = input;
  const from = edges[0] ?? 0;
  const to = edges.at(-1) ?? 0;
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const titles = new Map(input.threads.map((thread) => [thread.id, thread.title]));

  let totals = noSpend();
  const buckets = edges.slice(0, -1).map((start): SpendBucket => ({ start, ...noSpend() }));
  const providers = new Groups<ProviderId>((provider) => provider);
  const models = new Groups<{ provider: ProviderId; model: string }>(
    ({ provider, model }) => `${provider}\n${model}`,
  );
  const combos = new Groups<ComboKey>(
    ({ provider, model, effort, speed }) => `${provider}\n${model}\n${effort ?? ""}\n${speed ?? ""}`,
  );
  const threads = new Groups<AgentInfo["threadId"]>((id) => id);
  const byAgent = new Groups<AgentId>((id) => id);
  // Each agent's models by the tokens they used, for the one it ran most.
  const agentModels = new Map<AgentId, Map<string, number>>();

  for (const { turn, model, provider, effort, speed } of combosOf(input.events, agents)) {
    const agent = agents.get(turn.agentId);
    const empty = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0) + (turn.cachedInputTokens ?? 0) === 0;
    if (
      agent === undefined ||
      turn.at < from ||
      turn.at >= to ||
      (empty && turn.costUsd === undefined && !turn.unreported)
    ) {
      continue;
    }
    totals = add(totals, turn);
    // The turn is in the bucket from the last edge not after it.
    const index = edges.findLastIndex((edge) => edge <= turn.at);
    const bucket = buckets[index];
    if (bucket !== undefined) buckets[index] = { ...add(bucket, turn), start: bucket.start };
    providers.add(provider, turn);
    models.add({ provider, model }, turn);
    combos.add({ provider, model, effort, speed }, turn);
    threads.add(agent.threadId, turn);
    byAgent.add(agent.id, turn);
    const used = agentModels.get(agent.id) ?? new Map<string, number>();
    used.set(model, (used.get(model) ?? 0) + (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0));
    agentModels.set(agent.id, used);
  }

  return {
    totals,
    buckets,
    providers: providers.rows.map(({ key, total }) => ({ provider: key, ...total })),
    models: models.rows.map(({ key, total }): ModelSpend => ({ ...key, ...total })),
    combos: combos.rows.map(({ key, total }): ComboSpend => ({
      provider: key.provider,
      model: key.model,
      ...(key.effort === undefined ? {} : { effort: key.effort }),
      ...(key.speed === undefined ? {} : { speed: key.speed }),
      ...total,
    })),
    threads: threads.rows
      .slice(0, SPEND_ROWS)
      .map(({ key, total }): ThreadSpend => ({ threadId: key, title: titles.get(key) ?? "", ...total })),
    agents: byAgent.rows.slice(0, SPEND_ROWS).flatMap(({ key, total }): Array<AgentSpend> => {
      const agent = agents.get(key);
      if (agent === undefined) return [];
      const ran = [...(agentModels.get(key) ?? [])].toSorted((a, b) => b[1] - a[1])[0]?.[0];
      return [
        {
          ...total,
          agentId: agent.id,
          threadId: agent.threadId,
          title: titles.get(agent.threadId) ?? "",
          role: agent.role,
          provider: agent.provider,
          model: ran ?? agent.model,
        },
      ];
    }),
  };
};
