import { ClaudeAdapter } from "@cerium/adapter-claude";
import { BusHttpServer, BusRegistryLive, BusServer } from "@cerium/bus";
import { Adapters, Catalog, Orchestrator, OrchestratorConfig, type CatalogEntry } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Effect, Layer } from "effect";
import { join } from "node:path";

export interface BackendOptions {
  /** Where Cerium keeps its database and chat-thread folders (the app's user-data directory). */
  readonly dataDirectory: string;
  /** Until onboarding builds it, the catalog is passed in. */
  readonly catalog: ReadonlyArray<CatalogEntry>;
}

/** Every installed harness adapter. */
const AdaptersLive = Layer.effect(
  Adapters,
  Effect.gen(function* () {
    const claude = yield* ClaudeAdapter;
    return new Map([[claude.provider, claude]]);
  }),
).pipe(Layer.provide(ClaudeAdapter.layer));

/** The whole backend: store, orchestrator, harness adapters and the MCP bus on a loopback port. */
export const backendLayer = (options: BackendOptions) =>
  BusServer.pipe(
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(BusRegistryLive),
    Layer.provide(
      Layer.mergeAll(
        Store.layer({ filename: join(options.dataDirectory, "cerium.db") }),
        AdaptersLive,
        Catalog.fromEntries(options.catalog),
        OrchestratorConfig.layer({ chatDirectory: join(options.dataDirectory, "chats") }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
