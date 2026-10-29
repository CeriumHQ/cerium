import { ClaudeAdapter } from "@cerium/adapter-claude";
import { CodexAdapter } from "@cerium/adapter-codex";
import { CursorAdapter } from "@cerium/adapter-cursor";
import { MuseAdapter } from "@cerium/adapter-muse";
import { OpenCodeAdapter } from "@cerium/adapter-opencode";
import { BrowserHost, BusHttpServer, BusRegistryLive, BusRoutes } from "@cerium/bus";
import {
  Adapters,
  Orchestrator,
  OrchestratorConfig,
  SessionImports,
  UserSettings,
} from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Account, CloudThreads, DEFAULT_RELAY_URL, type AccountOptions, type Vault } from "@cerium/account";
import { Effect, Layer, type FileSystem, type Path } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { Socket } from "effect/socket";
import { homedir } from "node:os";
import { join } from "node:path";

import { Automations } from "./automations.ts";
import { Releases } from "./releases.ts";
import { Repositories } from "./clone.ts";
import { CatalogLive, OfferedModels } from "./catalog.ts";
import { checkpointsLayer } from "./checkpoints.ts";
import { thisMachine } from "./device.ts";
import { discordPresence } from "./discord.ts";
import { limitWarnings } from "./limits.ts";
import { loopbackHandoff } from "./linkHandoff.ts";
import { Notifications } from "./notify.ts";
import { SubscriptionUsage } from "./usage.ts";
import { remoteRoutes, TunnelSocketServer } from "./remote.ts";
import { Drafts, QuickWriter } from "./drafts.ts";
import { Files } from "./files.ts";
import { GitHub } from "./github.ts";
import { Git } from "./git.ts";
import { GitBranches } from "./gitBranches.ts";
import { GitChanges } from "./gitChanges.ts";
import { History } from "./history.ts";
import { mediaRoutes } from "./media.ts";
import { requireToken, rpcRoutes, tunnelRpcServer } from "./rpc.ts";
import { Projects } from "./project.ts";
import { projectScriptsLayer } from "./projectScripts.ts";
import { Pushes } from "./pushes.ts";
import { Reviews } from "./reviews.ts";
import { threadSlimming } from "./slimming.ts";
import { CloudCopy } from "./sync.ts";
import { Terminals } from "./terminal.ts";
import { Ptys } from "./terminalPty.ts";
import { ThreadEnv } from "./threadEnv.ts";
import { EffortRouter } from "./effortRouter.ts";
import { fileEffortRouterKey, fileVault, type EffortRouterKey } from "./vault.ts";
import { Workspace } from "./workspace.ts";
import { worktreesLayer } from "./worktree.ts";

export interface BackendOptions {
  /** Where Cerium keeps its database and chat-thread folders (the app's user-data directory). */
  readonly dataDirectory: string;
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
  /** Where the effort router's key is kept; by default a plain file in the data folder, like `vault`. */
  readonly effortRouterKey?: Layer.Layer<EffortRouterKey, never, FileSystem.FileSystem | Path.Path>;
}

/** Every harness adapter in this build. */
export const AdaptersLive = Layer.effect(
  Adapters,
  Effect.gen(function* () {
    const adapters = [
      yield* ClaudeAdapter,
      yield* CodexAdapter,
      yield* MuseAdapter,
      yield* CursorAdapter,
      yield* OpenCodeAdapter,
    ];
    return new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ClaudeAdapter.layer,
      CodexAdapter.layer,
      MuseAdapter.layer,
      CursorAdapter.layer,
      OpenCodeAdapter.layer,
    ),
  ),
);

/**
 * The whole backend: store, orchestrator and harness adapters, with the MCP bus and the UI's RPC
 * endpoint served on one loopback port.
 */
export const backendLayer = (options: BackendOptions) => {
  /** The one Terminals instance; its viewer's tabs and the scripts' own terminals share it. */
  const threadEnvLayer = ThreadEnv.layer();
  const terminalsLayer = Terminals.layer({
    version: options.account?.device.version ?? "dev",
  }).pipe(Layer.provide(Ptys.layer), Layer.provide(threadEnvLayer));

  return HttpRouter.serve(
    Layer.mergeAll(
      BusRoutes,
      rpcRoutes(options.token),
      remoteRoutes(requireToken(options.token)),
      mediaRoutes(requireToken(options.token)),
      // Other devices driving this machine through the relay.
      tunnelRpcServer.pipe(Layer.provide(TunnelSocketServer)),
    ),
    {
      disableListenLog: true,
      disableLogger: true,
    },
  ).pipe(
    // Tells when a subscription's usage limit nears (limits.ts), through the notifications below.
    // Beside it, the bus's `push` tool, and the pushes and CI checks each thread shows; over them, the
    // user's automations, which start threads on a schedule or when a push's CI fails.
    Layer.provideMerge(
      Automations.layer({ file: join(options.dataDirectory, "automations.json") }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            limitWarnings,
            Pushes.layer({ file: join(options.dataDirectory, "pushes.json") }),
            // The reviews of a diff by another harness each thread holds.
            Reviews.layer({ file: join(options.dataDirectory, "reviews.json") }),
          ),
        ),
      ),
    ),
    // Keeps the cloud copy of this machine's threads current, knows the account's, and
    // tells the account's browsers when a thread here needs the user, finished or failed. Shows
    // what the agents do on the user's Discord profile when they ask for it. Keeps the harnesses'
    // subscription usage for Settings → Usage. Slims threads gone quiet for the days the user chose.
    Layer.provideMerge(
      Layer.mergeAll(
        CloudCopy,
        CloudThreads.layer,
        Notifications.layer,
        discordPresence(),
        SubscriptionUsage.layer,
        threadSlimming,
      ),
    ),
    // With the effort router's decision model, through the user's own OpenRouter key. Beside it, what
    // brings the user's own harness sessions in as threads.
    Layer.provideMerge(
      Layer.mergeAll(
        Orchestrator.layer.pipe(
          Layer.provideMerge(EffortRouter.decider),
          Layer.provideMerge(
            EffortRouter.layer.pipe(
              Layer.provide(
                options.effortRouterKey ??
                  fileEffortRouterKey(join(options.dataDirectory, "effort-router.json")),
              ),
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
        ),
        SessionImports.layer,
      ),
    ),
    Layer.provideMerge(
      worktreesLayer({ directory: options.worktreeDirectory ?? join(homedir(), ".cerium", "worktrees") }),
    ),
    // Snapshots of work threads' folders, so the user can put them back as they were before a message.
    Layer.provideMerge(checkpointsLayer({ directory: join(options.dataDirectory, "checkpoints") })),
    Layer.provideMerge(Files.layer),
    // The user's own `gh`, for GitHub's pull requests and issues, and the commit messages, pull
    // requests and issues a quick model writes for the user to edit.
    Layer.provideMerge(Layer.mergeAll(GitHub.layer, Drafts.layer.pipe(Layer.provide(QuickWriter.layer)))),
    Layer.provideMerge(GitBranches.layer),
    Layer.provideMerge(GitChanges.layer),
    Layer.provideMerge(History.layer),
    Layer.provideMerge(Repositories.layer),
    // Each layer above needs what a layer below it provides, so Git comes after the git services.
    Layer.provideMerge(Git.layer),
    Layer.provideMerge(Workspace.layer({ attachmentsDirectory: join(options.dataDirectory, "attachments") })),
    // Projects, and the newest release of each harness and of `gh`, for Settings to offer the update.
    Layer.provideMerge(
      Layer.mergeAll(Projects.layer, Releases.layer.pipe(Layer.provide(FetchHttpClient.layer))),
    ),
    // Worktree scripts run in a terminal of the thread's own; the same Terminals instance feeds both.
    Layer.provideMerge([
      terminalsLayer,
      projectScriptsLayer.pipe(Layer.provide(terminalsLayer), Layer.provide(threadEnvLayer)),
    ]),
    Layer.provideMerge(
      Account.layer({
        handoff: loopbackHandoff,
        ...(options.account ?? { relayUrl: DEFAULT_RELAY_URL, device: thisMachine("dev", "dev") }),
      }).pipe(
        Layer.provide(options.vault ?? fileVault(join(options.dataDirectory, "account.json"))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    ),
    // With the catalog: the roster in the user's settings, applied to what the harnesses offer.
    // With the browser the desktop window hosts for the bus's browser tools.
    Layer.provideMerge(Layer.mergeAll(BusRegistryLive, CatalogLive, BrowserHost.layer)),
    Layer.provideMerge(UserSettings.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Store.layer({
          filename: join(options.dataDirectory, "cerium.db"),
          ...(options.migrationsFolder === undefined ? {} : { migrationsFolder: options.migrationsFolder }),
        }),
        OfferedModels.layer.pipe(Layer.provideMerge(AdaptersLive)),
        OrchestratorConfig.layer({
          chatDirectory: join(options.dataDirectory, "chats"),
          titleDirectory: join(options.dataDirectory, "titles"),
        }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
};
