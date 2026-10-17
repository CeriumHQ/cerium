import { Adapters, Orchestrator, type OrchestratorError } from "@cerium/orchestrator";
import { CeriumError, CeriumRpcs } from "@cerium/rpc";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { timingSafeEqual } from "node:crypto";

export const RPC_PATH = "/rpc";

const refuse = (error: OrchestratorError) => new CeriumError({ message: error.message });

const Handlers = CeriumRpcs.toLayer(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const adapters = yield* Adapters;

    return CeriumRpcs.of({
      ListThreads: () =>
        orchestrator.listThreads.pipe(
          Effect.flatMap((threads) =>
            Effect.forEach(threads, (thread) =>
              orchestrator.listAgents(thread.id).pipe(
                Effect.map((agents) => ({
                  thread,
                  agents,
                  awaitingApproval: orchestrator.awaitingApproval(thread.id),
                })),
              ),
            ),
          ),
          Effect.mapError(refuse),
        ),
      ThreadEvents: ({ threadId }) => orchestrator.threadEvents(threadId).pipe(Effect.mapError(refuse)),
      WatchEvents: () => orchestrator.events,
      CreateThread: (payload) => orchestrator.createThread(payload).pipe(Effect.mapError(refuse)),
      SendMessage: ({ agentId, text }) =>
        orchestrator.sendUserMessage(agentId, text).pipe(Effect.mapError(refuse)),
      RespondToPermission: ({ agentId, requestId, decision, scope }) =>
        orchestrator
          .respondToPermission(agentId, requestId, { decision, scope })
          .pipe(Effect.mapError(refuse)),
      ResolveSpawnApproval: ({ requestId, decision, replacement }) =>
        orchestrator
          .resolveSpawnApproval(requestId, { decision, ...(replacement ? { replacement } : {}) })
          .pipe(Effect.mapError(refuse)),
      InterruptAgent: ({ agentId, includeChildren }) =>
        orchestrator
          .interruptAgent(agentId, includeChildren === undefined ? {} : { includeChildren })
          .pipe(Effect.mapError(refuse)),
      StopAgent: ({ agentId }) => orchestrator.stopAgent(agentId).pipe(Effect.mapError(refuse)),
      HarnessStatuses: () =>
        Effect.forEach([...adapters.values()], (adapter) => Effect.option(adapter.probe), {
          concurrency: "unbounded",
        }).pipe(Effect.map((statuses) => statuses.flatMap(Option.toArray))),
    });
  }),
);

const sameSecret = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/**
 * Only the UI holding this launch's token may connect. Browsers can't set WebSocket headers, so the
 * token travels in the query string; the check happens before the upgrade.
 */
const requireToken = (token: string) =>
  HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const given = new URL(request.url, "http://localhost").searchParams.get("token") ?? "";
      if (!sameSecret(given, token)) return HttpServerResponse.empty({ status: 401 });
      return yield* httpEffect;
    }),
  ).layer;

/** The UI's RPC endpoint. Requires the Orchestrator, Adapters and an HttpRouter. */
export const rpcRoutes = (token: string) =>
  RpcServer.layer(CeriumRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(
      RpcServer.layerProtocolWebsocket({ path: RPC_PATH }).pipe(Layer.provide(requireToken(token))),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
