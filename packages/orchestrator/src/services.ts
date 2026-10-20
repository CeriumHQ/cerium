import type { HarnessAdapter, McpServerSpec } from "@cerium/harness";
import type {
  AgentId,
  ProviderId,
  ReasoningEffort,
  ThreadId,
  ThreadWorktree,
  WorktreeChanges,
} from "@cerium/protocol";
import { Context, Duration, Effect, Layer, Schema } from "effect";

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

/**
 * Models the lead may spawn without asking the user. `entries` waits for the catalog to be known, which
 * the backend learns from the harnesses after it starts serving.
 */
export class Catalog extends Context.Service<
  Catalog,
  { readonly entries: Effect.Effect<ReadonlyArray<CatalogEntry>> }
>()("cerium/orchestrator/Catalog") {
  static fromEntries = (entries: ReadonlyArray<CatalogEntry>) =>
    Layer.succeed(Catalog, { entries: Effect.succeed(entries) });
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

/** Why a worktree couldn't be made, removed or read; `message` is written for the user. */
export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  message: Schema.String,
}) {}

/** A new thread's worktree, and the folder its agents work in there. */
export interface NewWorktree {
  readonly worktree: ThreadWorktree;
  readonly cwd: string;
}

/** Git worktrees threads run in, so threads in one project keep out of each other's files. */
export class Worktrees extends Context.Service<
  Worktrees,
  {
    /**
     * Checks the repository `project` is in out into a worktree of its own, on a new branch named after
     * `name`, from the branch checked out there; the git-ignored files its include list names are
     * copied in.
     */
    create(project: string, name: string): Effect.Effect<NewWorktree, WorktreeError>;
    /** What the worktree holds that its base doesn't. */
    changes(worktree: ThreadWorktree): Effect.Effect<WorktreeChanges, WorktreeError>;
    /**
     * Removes the worktree of thread `threadId` with what isn't committed there; its branch stays
     * while it holds commits its base doesn't.
     */
    remove(threadId: ThreadId, worktree: ThreadWorktree): Effect.Effect<void, WorktreeError>;
    /** Puts a removed worktree back where it was, on its branch, or afresh from its base without one. */
    restore(worktree: ThreadWorktree): Effect.Effect<void, WorktreeError>;
  }
>()("cerium/orchestrator/Worktrees") {
  /** For builds and tests without git: no thread gets a worktree. */
  static readonly unavailable = Layer.succeed(Worktrees, {
    create: () => Effect.fail(new WorktreeError({ message: "Worktrees aren't available here." })),
    changes: () => Effect.succeed({ uncommitted: 0, unmerged: 0 }),
    remove: () => Effect.void,
    restore: () => Effect.fail(new WorktreeError({ message: "Worktrees aren't available here." })),
  });
}

export interface OrchestratorSettings {
  /** Chat threads have no folder; each gets an empty directory under here as the harness's cwd. */
  readonly chatDirectory: string;
  /** The empty folder title completions run in, so no project's instructions load (default `<chatDirectory>/.titles`). */
  readonly titleDirectory?: string;
  /** How long to wait for more notices before delivering a batch to an idle agent. */
  readonly batchWindow: Duration.Duration;
  /** Agents running a turn at once across every provider. */
  readonly globalConcurrency: number;
  /** Messages one agent may send another within `messageBudget.window`. */
  readonly messageBudget: { readonly limit: number; readonly window: Duration.Duration };
  /** Longest message or child result delivered inline; longer text is cut. */
  readonly maxDeliveredChars: number;
  /** Whether stopping a lead also stops its children. */
  readonly stopChildrenWithLead: boolean;
}

export class OrchestratorConfig extends Context.Service<OrchestratorConfig, OrchestratorSettings>()(
  "cerium/orchestrator/OrchestratorConfig",
) {
  static layer = (settings: Pick<OrchestratorSettings, "chatDirectory"> & Partial<OrchestratorSettings>) =>
    Layer.succeed(OrchestratorConfig, {
      batchWindow: Duration.seconds(2),
      globalConcurrency: 12,
      // Placeholder until tuned from real usage.
      messageBudget: { limit: 10, window: Duration.minutes(30) },
      maxDeliveredChars: 8_000,
      stopChildrenWithLead: false,
      ...settings,
    });
}
