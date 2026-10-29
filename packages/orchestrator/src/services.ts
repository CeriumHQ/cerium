import type { HarnessAdapter, McpServerSpec } from "@cerium/harness";
import type {
  AgentId,
  ModelChoice,
  ModelInfo,
  ModelSpeed,
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
  /** The speed it starts at; absent, the harness's own default. */
  readonly speed?: ModelSpeed;
  /** Plain-language "use this for…" description the lead picks models by. */
  readonly description: string;
  /** 1 for the model the user wants first among its harness's, counting down; absent, unranked. */
  readonly priority?: number;
}

/**
 * Models the lead may spawn without asking the user: the user's roster. `entries` waits for the
 * catalog to be known, which the backend learns from the harnesses after it starts serving.
 */
export class Catalog extends Context.Service<
  Catalog,
  {
    readonly entries: Effect.Effect<ReadonlyArray<CatalogEntry>>;
    /**
     * Every model the harnesses offer, on the roster or not, with their efforts, for the effort router
     * and the quick models; absent where nothing listed them.
     */
    readonly models?: Effect.Effect<ReadonlyArray<ModelInfo>>;
  }
>()("cerium/orchestrator/Catalog") {
  static fromEntries = (entries: ReadonlyArray<CatalogEntry>) =>
    Layer.succeed(Catalog, { entries: Effect.succeed(entries) });
}

/**
 * The models the harnesses offer, on the roster or not, as harness and id: the catalog's entries where
 * it doesn't list them all.
 */
export const offeredModels = (catalog: Catalog["Service"]): Effect.Effect<ReadonlyArray<ModelChoice>> =>
  catalog.models === undefined
    ? Effect.map(catalog.entries, (entries) => entries.map(({ provider, model }) => ({ provider, model })))
    : Effect.map(catalog.models, (models) => models.map(({ provider, id }) => ({ provider, model: id })));

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
     * Picks a worktree for the repository `project` is in, on a new branch named after `name`, from the
     * branch checked out there. Quick: nothing is checked out until `checkOut`, and the name is kept
     * from other plans until then.
     */
    plan(project: string, name: string): Effect.Effect<NewWorktree, WorktreeError>;
    /**
     * Checks a planned worktree out, copying in the git-ignored files its include list names;
     * resolves with those files, relative to its root.
     */
    checkOut(worktree: ThreadWorktree): Effect.Effect<ReadonlyArray<string>, WorktreeError>;
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
    plan: () => Effect.fail(new WorktreeError({ message: "Worktrees aren't available here." })),
    checkOut: () => Effect.fail(new WorktreeError({ message: "Worktrees aren't available here." })),
    changes: () => Effect.succeed({ uncommitted: 0, unmerged: 0 }),
    remove: () => Effect.void,
    restore: () => Effect.fail(new WorktreeError({ message: "Worktrees aren't available here." })),
  });
}

/** Why a folder's files couldn't be saved, compared or put back; `message` is written for the user. */
export class CheckpointError extends Schema.TaggedError<CheckpointError>()("CheckpointError", {
  message: Schema.String,
}) {}

/** A file that differs between two snapshots, and what became of it from the first to the second. */
export interface SnapshotChange {
  /** Relative to the folder, with forward slashes. */
  readonly path: string;
  readonly change: "added" | "modified" | "deleted";
}

/** The lines a file gained and lost between two snapshots; neither for a file that isn't text. */
export interface SnapshotLines {
  /** Relative to the folder, with forward slashes. */
  readonly path: string;
  readonly added?: number;
  readonly removed?: number;
}

/**
 * Snapshots of a work thread's folder, taken as its agents' turns start and end, so the user can put
 * the files back as they were before one of their messages. Kept apart from the folder's own
 * repository: nothing of the user's changes.
 */
export class Checkpoints extends Context.Service<
  Checkpoints,
  {
    /**
     * Saves the files in `folder` as they are now; resolves with the snapshot's id. With `reuse`, the
     * last snapshot serves when nothing in the folder is known to have changed since it was taken.
     */
    save(folder: string, options?: { readonly reuse?: boolean }): Effect.Effect<string, CheckpointError>;
    /** The files that differ between two snapshots of `folder`. */
    changes(
      folder: string,
      from: string,
      to: string,
    ): Effect.Effect<ReadonlyArray<SnapshotChange>, CheckpointError>;
    /** The lines each file that differs between two snapshots of `folder` gained and lost. */
    lines(
      folder: string,
      from: string,
      to: string,
    ): Effect.Effect<ReadonlyArray<SnapshotLines>, CheckpointError>;
    /** One file's changes between two snapshots of `folder`, as git's unified diff with `context` lines. */
    diff(
      folder: string,
      from: string,
      to: string,
      path: string,
      context: number,
    ): Effect.Effect<string, CheckpointError>;
    /** Puts `paths` back as `snapshot` holds them, removing those it doesn't hold. */
    restore(
      folder: string,
      snapshot: string,
      paths: ReadonlyArray<string>,
    ): Effect.Effect<void, CheckpointError>;
  }
>()("cerium/orchestrator/Checkpoints") {
  /** For builds and tests without git: no turn saves the files, so a restore leaves them as they are. */
  static readonly unavailable = Layer.succeed(Checkpoints, {
    save: () => Effect.fail(new CheckpointError({ message: "Snapshots aren't available here." })),
    changes: () => Effect.succeed([]),
    lines: () => Effect.succeed([]),
    diff: () => Effect.fail(new CheckpointError({ message: "Snapshots aren't available here." })),
    restore: () => Effect.fail(new CheckpointError({ message: "Snapshots aren't available here." })),
  });
}

export interface OrchestratorSettings {
  /** Chat threads have no folder; each gets an empty directory under here as the harness's cwd. */
  readonly chatDirectory: string;
  /** The empty folder title completions run in, so no project's instructions load (default `<chatDirectory>/.titles`). */
  readonly titleDirectory?: string;
  /** How long to wait for more notices before delivering a batch to an idle agent. */
  readonly batchWindow: Duration.Duration;
  /** Idle hosts beyond the warm pool are closed after this grace period, then resumed on demand. */
  readonly idleSessionTTL: Duration.Duration;
  readonly warmSessions: number;
  /** Messages one agent may send another within `messageBudget.window`. */
  readonly messageBudget: { readonly limit: number; readonly window: Duration.Duration };
  /**
   * Threads agents may start with `create_thread` within `threadBudget.window`, all agents together, so
   * leads starting threads whose leads start more can't run away.
   */
  readonly threadBudget: { readonly limit: number; readonly window: Duration.Duration };
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
      idleSessionTTL: Duration.minutes(5),
      warmSessions: 4,
      // Placeholder until tuned from real usage.
      messageBudget: { limit: 10, window: Duration.minutes(30) },
      threadBudget: { limit: 12, window: Duration.minutes(30) },
      maxDeliveredChars: 8_000,
      stopChildrenWithLead: false,
      ...settings,
    });
}
