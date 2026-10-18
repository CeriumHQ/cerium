import type { HarnessAdapter, McpServerSpec } from "@cerium/harness";
import type { AgentId, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { Context, Duration, Layer, type Effect } from "effect";

/** The harness adapters installed in this build, by provider. */
export class Adapters extends Context.Service<Adapters, ReadonlyMap<ProviderId, HarnessAdapter>>()(
  "cerium/orchestrator/Adapters",
) {
  static fromList = (adapters: ReadonlyArray<HarnessAdapter>) =>
    Layer.succeed(Adapters, new Map(adapters.map((adapter) => [adapter.provider, adapter])));
}

export interface CatalogEntry {
  /** The name agents and the user refer to the model by, e.g. `ci-babysitter`. */
  readonly alias: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** Plain-language "use this for…" description the lead picks models by. */
  readonly description: string;
}

/** Models the lead may spawn without asking the user (docs/architecture.md §3.3, §4). */
export class Catalog extends Context.Service<Catalog, { readonly entries: ReadonlyArray<CatalogEntry> }>()(
  "cerium/orchestrator/Catalog",
) {
  static fromEntries = (entries: ReadonlyArray<CatalogEntry>) => Layer.succeed(Catalog, { entries });
}

/** How a session reaches Cerium's MCP bus. Implemented by the bus; each agent gets its own credentials. */
export class BusEndpoint extends Context.Service<
  BusEndpoint,
  {
    /** The server name sessions see the bus under. */
    readonly serverName: string;
    register(agentId: AgentId): Effect.Effect<McpServerSpec>;
    unregister(agentId: AgentId): Effect.Effect<void>;
  }
>()("cerium/orchestrator/BusEndpoint") {}

export interface OrchestratorSettings {
  /** Chat threads have no folder; each gets an empty directory under here as the harness's cwd. */
  readonly chatDirectory: string;
  /** The empty folder title completions run in, so no project's instructions load (default `<chatDirectory>/.titles`). */
  readonly titleDirectory?: string;
  /** How long to wait for more notices before delivering a batch to an idle agent. */
  readonly batchWindow: Duration.Duration;
  /** Agents running a turn at once across every provider. */
  readonly globalConcurrency: number;
  /** Messages one agent may send another within `messageBudget.window` (architecture §3.4). */
  readonly messageBudget: { readonly limit: number; readonly window: Duration.Duration };
  /** Longest message or child result delivered inline; longer text is cut. */
  readonly maxDeliveredChars: number;
  /** Whether stopping a lead also stops its children (architecture §3.8). */
  readonly stopChildrenWithLead: boolean;
}

export class OrchestratorConfig extends Context.Service<OrchestratorConfig, OrchestratorSettings>()(
  "cerium/orchestrator/OrchestratorConfig",
) {
  static layer = (settings: Pick<OrchestratorSettings, "chatDirectory"> & Partial<OrchestratorSettings>) =>
    Layer.succeed(OrchestratorConfig, {
      batchWindow: Duration.seconds(2),
      globalConcurrency: 12,
      // Placeholder until tuned from real usage (docs/architecture.md §12).
      messageBudget: { limit: 10, window: Duration.minutes(30) },
      maxDeliveredChars: 8_000,
      stopChildrenWithLead: false,
      ...settings,
    });
}
