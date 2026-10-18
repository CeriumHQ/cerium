import { ClaudeAdapter } from "@cerium/adapter-claude";
import { CodexAdapter } from "@cerium/adapter-codex";
import { CursorAdapter } from "@cerium/adapter-cursor";
import { MuseAdapter } from "@cerium/adapter-muse";
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
import type { ModelInfo } from "@cerium/protocol";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { join } from "node:path";

import { rpcRoutes } from "./rpc.ts";
import { Projects } from "./project.ts";
import { Workspace } from "./workspace.ts";

export interface BackendOptions {
  /** Where Cerium keeps its database and chat-thread folders (the app's user-data directory). */
  readonly dataDirectory: string;
  /** Hand-picked catalog entries; until onboarding builds the catalog, they lead it (see `CatalogLive`). */
  readonly catalog: ReadonlyArray<CatalogEntry>;
  /** This launch's secret; the UI must present it to use the RPC endpoint. */
  readonly token: string;
  /** The store's migrations, when they don't sit beside `@cerium/store` (a bundled backend). */
  readonly migrationsFolder?: string;
}

/** Every harness adapter in this build. */
const AdaptersLive = Layer.effect(
  Adapters,
  Effect.gen(function* () {
    const adapters = [yield* ClaudeAdapter, yield* CodexAdapter, yield* MuseAdapter, yield* CursorAdapter];
    return new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(ClaudeAdapter.layer, CodexAdapter.layer, MuseAdapter.layer, CursorAdapter.layer),
  ),
);

/**
 * Until onboarding builds the catalog with the user (architecture §4), every model a logged-in harness
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

/** The catalog, read once at startup: a harness logged in later joins it after a restart. */
const CatalogLive = (curated: ReadonlyArray<CatalogEntry>) =>
  Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const offered = yield* Effect.forEach(
        [...adapters.values()],
        (adapter) =>
          adapter.listModels.pipe(
            Effect.timeout(MODEL_LIST_TIMEOUT),
            Effect.orElseSucceed((): ReadonlyArray<ModelInfo> => []),
          ),
        { concurrency: "unbounded" },
      );
      return { entries: catalogFrom(curated, offered.flat()) };
    }),
  ).pipe(Layer.provide(AdaptersLive));

/**
 * The whole backend: store, orchestrator and harness adapters, with the MCP bus and the UI's RPC
 * endpoint served on one loopback port.
 */
export const backendLayer = (options: BackendOptions) =>
  HttpRouter.serve(Layer.mergeAll(BusRoutes, rpcRoutes(options.token)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(Workspace.layer({ attachmentsDirectory: join(options.dataDirectory, "attachments") })),
    Layer.provideMerge(Projects.layer),
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
        OrchestratorConfig.layer({ chatDirectory: join(options.dataDirectory, "chats") }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
