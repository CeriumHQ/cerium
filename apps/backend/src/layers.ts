import { ClaudeAdapter } from "@cerium/adapter-claude";
import { CodexAdapter } from "@cerium/adapter-codex";
import { CursorAdapter } from "@cerium/adapter-cursor";
import { OpenCodeAdapter } from "@cerium/adapter-opencode";
import { BusHttpServer, BusRegistryLive, BusRoutes } from "@cerium/bus";
import {
  Adapters,
  Catalog,
  Orchestrator,
  OrchestratorConfig,
  UserSettings,
  type CatalogEntry,
} from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Account, CloudThreads, DEFAULT_RELAY_URL, type AccountOptions, type Vault } from "@cerium/account";
import type { ModelInfo } from "@cerium/protocol";
import { Deferred, Effect, Layer, type FileSystem, type Path } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { Socket } from "effect/socket";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkpointsLayer } from "./checkpoints.ts";
import { thisMachine } from "./device.ts";
import { discordPresence } from "./discord.ts";
import { limitWarnings } from "./limits.ts";
import { Notifications } from "./notify.ts";
import { SubscriptionUsage } from "./usage.ts";
import { remoteRoutes, TunnelSocketServer } from "./remote.ts";
import { Files } from "./files.ts";
import { requireToken, rpcRoutes, tunnelRpcServer } from "./rpc.ts";
import { Projects } from "./project.ts";
import { CloudCopy } from "./sync.ts";
import { Terminals } from "./terminal.ts";
import { Ptys } from "./terminalPty.ts";
import { fileVault } from "./vault.ts";
import { Workspace } from "./workspace.ts";
import { worktreesLayer } from "./worktree.ts";

export interface BackendOptions {
  /** Where Cerium keeps its database and chat-thread folders (the app's user-data directory). */
  readonly dataDirectory: string;
  /** Hand-picked catalog entries; until onboarding builds the catalog, they lead it (see `CatalogLive`). */
  readonly catalog: ReadonlyArray<CatalogEntry>;
  /** This launch's secret; the UI must present it to use the RPC endpoint. */
  readonly token: string;
  /** The store's migrations, when they don't sit beside `@cerium/store` (a bundled backend). */
  readonly migrationsFolder?: string;
  /** The relay this machine signs in to and how it describes itself; Cerium's own, as a development build, by default. */
  readonly account?: AccountOptions;
  /**
   * Where threads' worktrees go, a folder per repository; `~/.cerium/worktrees` by default, outside
   * any project, whichever data folder the backend runs with.
   */
  readonly worktreeDirectory?: string;
  /** Where the sign-in is kept; by default a plain file in the data folder, as a development backend keeps it. */
  readonly vault?: Layer.Layer<Vault, never, FileSystem.FileSystem | Path.Path>;
}

/**
 * Every harness adapter in this build. Muse's stays out until `muse serve` runs sandboxed commands on
 * Windows (`OFFERED_PROVIDERS`); a thread it ran still opens, and says no Muse adapter is installed.
 */
export const AdaptersLive = Layer.effect(
  Adapters,
  Effect.gen(function* () {
    const adapters = [
      yield* ClaudeAdapter,
      yield* CodexAdapter,
      yield* CursorAdapter,
      yield* OpenCodeAdapter,
    ];
    return new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(ClaudeAdapter.layer, CodexAdapter.layer, CursorAdapter.layer, OpenCodeAdapter.layer),
  ),
);

/**
 * Until onboarding builds the catalog with the user, every model a logged-in harness
 * offers can be spawned without asking. Hand-picked entries come first and keep their aliases and
 * descriptions; the rest are known by their id, or `provider/id` where ids collide.
 */
export const catalogFrom = (
  curated: ReadonlyArray<CatalogEntry>,
  offered: ReadonlyArray<ModelInfo>,
): ReadonlyArray<CatalogEntry> => {
  const fresh = offered.filter(
    (model) => !curated.some((entry) => entry.provider === model.provider && entry.model === model.id),
  );
  const aliases = new Set(curated.map((entry) => entry.alias));
  const collides = (model: ModelInfo) =>
    aliases.has(model.id) || fresh.some((other) => other !== model && other.id === model.id);
  return [
    ...curated,
    ...fresh.map((model): CatalogEntry => ({
      alias: collides(model) ? `${model.provider}/${model.id}` : model.id,
      provider: model.provider,
      model: model.id,
      description: model.description ?? model.label,
    })),
  ];
};

/** How long each harness may take to list its models while the backend starts. */
const MODEL_LIST_TIMEOUT = "20 seconds";

/**
 * The catalog, read once at startup: a harness logged in later joins it after a restart. The harnesses
 * take seconds to list their models, so the backend serves meanwhile and only a spawn waits for them.
 */
const CatalogLive = (curated: ReadonlyArray<CatalogEntry>) =>
  Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const known = yield* Deferred.make<ReadonlyArray<CatalogEntry>>();
      yield* Effect.forEach(
        [...adapters.values()],
        (adapter) =>
          adapter.listModels.pipe(
            Effect.timeout(MODEL_LIST_TIMEOUT),
            Effect.orElseSucceed((): ReadonlyArray<ModelInfo> => []),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap((offered) => Deferred.succeed(known, catalogFrom(curated, offered.flat()))),
        Effect.forkScoped,
      );
      return { entries: Deferred.await(known) };
    }),
  ).pipe(Layer.provide(AdaptersLive));

/**
 * The whole backend: store, orchestrator and harness adapters, with the MCP bus and the UI's RPC
 * endpoint served on one loopback port.
 */
export const backendLayer = (options: BackendOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(
      BusRoutes,
      rpcRoutes(options.token),
      remoteRoutes(requireToken(options.token)),
      // Other devices driving this machine through the relay.
      tunnelRpcServer.pipe(Layer.provide(TunnelSocketServer)),
    ),
    {
      disableListenLog: true,
      disableLogger: true,
    },
  ).pipe(
    // Tells when a subscription's usage limit nears (limits.ts), through the notifications below.
    Layer.provideMerge(limitWarnings),
    // Keeps the cloud copy of this machine's threads current, knows the account's, and
    // tells the account's browsers when a thread here needs the user, finished or failed. Shows
    // what the agents do on the user's Discord profile when they ask for it. Keeps the harnesses'
    // subscription usage for Settings → Usage.
    Layer.provideMerge(
      Layer.mergeAll(
        CloudCopy,
        CloudThreads.layer,
        Notifications.layer,
        discordPresence(),
        SubscriptionUsage.layer,
      ),
    ),
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(
      worktreesLayer({ directory: options.worktreeDirectory ?? join(homedir(), ".cerium", "worktrees") }),
    ),
    // Snapshots of work threads' folders, so the user can put them back as they were before a message.
    Layer.provideMerge(checkpointsLayer({ directory: join(options.dataDirectory, "checkpoints") })),
    Layer.provideMerge(Files.layer),
    Layer.provideMerge(Workspace.layer({ attachmentsDirectory: join(options.dataDirectory, "attachments") })),
    Layer.provideMerge(Projects.layer),
    Layer.provideMerge(
      Terminals.layer({ version: options.account?.device.version ?? "dev" }).pipe(Layer.provide(Ptys.layer)),
    ),
    Layer.provideMerge(
      Account.layer(
        options.account ?? { relayUrl: DEFAULT_RELAY_URL, device: thisMachine("dev", "dev") },
      ).pipe(
        Layer.provide(options.vault ?? fileVault(join(options.dataDirectory, "account.json"))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    ),
    Layer.provideMerge(BusRegistryLive),
    Layer.provideMerge(UserSettings.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Store.layer({
          filename: join(options.dataDirectory, "cerium.db"),
          ...(options.migrationsFolder === undefined ? {} : { migrationsFolder: options.migrationsFolder }),
        }),
        AdaptersLive,
        CatalogLive(options.catalog),
        OrchestratorConfig.layer({
          chatDirectory: join(options.dataDirectory, "chats"),
          titleDirectory: join(options.dataDirectory, "titles"),
        }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
