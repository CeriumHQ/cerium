import { ClaudeAdapter } from "@cerium/adapter-claude";
import { BusHttpServer, BusRegistryLive, BusRoutes } from "@cerium/bus";
import { Adapters, Catalog, Orchestrator, OrchestratorConfig, type CatalogEntry } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { join } from "node:path";

import { rpcRoutes } from "./rpc.ts";

export interface BackendOptions {
  /** Where Cerium keeps its database and chat-thread folders (the app's user-data directory). */
  readonly dataDirectory: string;
  /** Until onboarding builds it, the catalog is passed in. */
  readonly catalog: ReadonlyArray<CatalogEntry>;
  /** This launch's secret; the UI must present it to use the RPC endpoint. */
  readonly token: string;
}

/** Every installed harness adapter. */
const AdaptersLive = Layer.effect(
  Adapters,
  Effect.gen(function* () {
    const claude = yield* ClaudeAdapter;
    return new Map([[claude.provider, claude]]);
  }),
).pipe(Layer.provide(ClaudeAdapter.layer));

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
    Layer.provideMerge(BusRegistryLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Store.layer({ filename: join(options.dataDirectory, "cerium.db") }),
        AdaptersLive,
        Catalog.fromEntries(options.catalog),
        OrchestratorConfig.layer({ chatDirectory: join(options.dataDirectory, "chats") }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
