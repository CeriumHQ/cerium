import type { HarnessAdapter } from "@cerium/harness";
import type { AgentEvent } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Adapters,
  BusEndpoint,
  Catalog,
  Checkpoints,
  Orchestrator,
  OrchestratorConfig,
  UserSettings,
  Worktrees,
  type CatalogEntry,
} from "../src/index.ts";

export const fakeBus = Layer.succeed(BusEndpoint, {
  serverName: "cerium",
  register: (agentId) => Effect.succeed({ type: "http" as const, url: `http://bus.test/${agentId}` }),
  unregister: () => Effect.void,
});

export const testStore = (filename = ":memory:") =>
  Store.layer({ filename, migrationsFolder: join(import.meta.dirname, "../../store/migrations") });

export const testLayer = (
  adapters: ReadonlyArray<HarnessAdapter>,
  options: {
    readonly catalog?: ReadonlyArray<CatalogEntry>;
    readonly messageLimit?: number;
    readonly threadLimit?: number;
    readonly worktrees?: Layer.Layer<Worktrees>;
    readonly checkpoints?: Layer.Layer<Checkpoints>;
    /** A database file to keep across layers, as the app keeps it across restarts. */
    readonly database?: string;
  } = {},
) =>
  Orchestrator.layer.pipe(
    Layer.provideMerge(UserSettings.layer),
    Layer.provideMerge(testStore(options.database)),
    Layer.provide(Adapters.fromList(adapters)),
    Layer.provide(Catalog.fromEntries(options.catalog ?? [])),
    Layer.provide(fakeBus),
    Layer.provide(options.worktrees ?? Worktrees.unavailable),
    Layer.provide(options.checkpoints ?? Checkpoints.unavailable),
    Layer.provide(
      OrchestratorConfig.layer({
        chatDirectory: mkdtempSync(join(tmpdir(), "cerium-chat-")),
        batchWindow: Duration.millis(20),
        messageBudget: { limit: options.messageLimit ?? 10, window: Duration.minutes(30) },
        threadBudget: { limit: options.threadLimit ?? 12, window: Duration.minutes(30) },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Records every live event and waits for conditions on them. */
export const recordEvents = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const seen: Array<AgentEvent> = [];
  yield* orchestrator.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
    Effect.forkScoped,
  );
  // Let the subscription start before the test acts.
  yield* Effect.sleep(Duration.millis(5));
  const waitFor = <A>(find: (events: ReadonlyArray<AgentEvent>) => A | undefined) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = find(seen);
        if (found !== undefined) return found;
        yield* Effect.sleep(Duration.millis(5));
      }
      return yield* Effect.die(new Error("Timed out waiting for an event"));
    });
  return { seen, waitFor };
});
