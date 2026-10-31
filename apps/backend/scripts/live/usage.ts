import type { HarnessAdapter } from "@cerium/harness";
import {
  Adapters,
  Catalog,
  Checkpoints,
  Orchestrator,
  OrchestratorConfig,
  ProjectScripts,
  UserSettings,
  Worktrees,
} from "@cerium/orchestrator";
import { BrowserHost, BusHttpServer, BusRegistryLive, BusServer, PushHost } from "@cerium/bus";
import { Computer } from "@cerium/computer";
import type { EventPayload } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Deferred, Effect, Layer, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT = "Reply with only READY. Do not call tools or change files.";

interface Reading {
  input: number;
  cached: number;
  output: number;
  contextReadings: number;
  context?: number;
  reply: string;
  errors: string[];
}

const reading = (): Reading => ({
  input: 0,
  cached: 0,
  output: 0,
  contextReadings: 0,
  reply: "",
  errors: [],
});
const record = (into: Reading, event: EventPayload) => {
  if (event._tag === "UsageReported" && event.purpose === undefined) {
    into.input += event.inputTokens;
    into.cached += event.cachedInputTokens ?? 0;
    into.output += event.outputTokens;
  }
  if (event._tag === "ContextReported") {
    into.contextReadings++;
    into.context ??= event.tokens;
  }
  if (event._tag === "MessageCompleted") into.reply = event.text;
  if (event._tag === "AgentError") into.errors.push(event.message);
  if (event._tag === "AuthRequired") into.errors.push(event.reason);
};

/** Two short cold sessions, same model/effort/speed/folder/user connections; only Cerium differs. */
export const compareUsage = Effect.fn("Live.compareUsage")(function* (
  adapter: HarnessAdapter,
  model: string,
) {
  const folder = mkdtempSync(join(tmpdir(), "cerium-usage-ab-"));
  const native = yield* Effect.gen(function* () {
    const result = reading();
    const session = yield* adapter.startSession({
      cwd: folder,
      model,
      effort: "low",
      speed: "standard",
      access: "readOnly",
      mcpServers: {},
      includeUserMcpServers: true,
    });
    yield* session.send(PROMPT);
    yield* session.events.pipe(
      Stream.takeUntil((e) => e.payload._tag === "TurnCompleted"),
      Stream.runForEach((e) => Effect.sync(() => record(result, e.payload))),
    );
    return result;
  }).pipe(Effect.scoped, Effect.timeout("90 seconds"));

  const stack = BusServer.pipe(
    Layer.provideMerge(Orchestrator.layer),
    Layer.provideMerge(BusRegistryLive),
    Layer.provide(BrowserHost.layer),
    Layer.provide(PushHost.unavailable),
    Layer.provide(Computer.unavailable),
    Layer.provideMerge(UserSettings.layer),
    Layer.provide(
      Layer.mergeAll(
        Store.layer({
          filename: ":memory:",
          migrationsFolder: join(import.meta.dirname, "../../../../packages/store/migrations"),
        }),
        Adapters.fromList([adapter]),
        Catalog.fromEntries([
          { alias: "probe", provider: adapter.provider, model, description: "Usage probe" },
        ]),
        Worktrees.unavailable,
        Checkpoints.unavailable,
        ProjectScripts.unavailable,
        OrchestratorConfig.layer({ chatDirectory: folder }),
      ),
    ),
    Layer.provideMerge(BusHttpServer),
  );
  const cerium = yield* Effect.gen(function* () {
    const settings = yield* UserSettings;
    yield* settings.update({
      titles: { enabled: false },
      advisor: { enabled: false },
      effortRouter: { enabled: false, children: "router" },
    });
    const orchestrator = yield* Orchestrator;
    const result = reading();
    const { lead } = yield* orchestrator.createThread({
      title: "Usage comparison",
      mode: "work",
      cwd: folder,
      lead: { provider: adapter.provider, model, effort: "low", speed: "standard", access: "readOnly" },
    });
    const done = yield* Deferred.make<void>();
    yield* orchestrator.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.agentId !== lead.id) return;
          record(result, event.payload);
          if (event.payload._tag === "TurnCompleted") yield* Deferred.succeed(done, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* orchestrator.sendUserMessage(lead.id, PROMPT);
    yield* Deferred.await(done);
    return result;
  }).pipe(Effect.provide(stack), Effect.scoped, Effect.timeout("90 seconds"));
  return {
    provider: adapter.provider,
    model,
    effort: "low",
    speed: "standard",
    native,
    cerium,
    passed:
      native.reply.trim().includes("READY") &&
      cerium.reply.trim().includes("READY") &&
      native.errors.length === 0 &&
      cerium.errors.length === 0,
  };
});
