import type { AgentId } from "@cerium/protocol";
import { BusEndpoint } from "@cerium/orchestrator";
import { Context, Crypto, Effect, Layer, Option } from "effect";
import { HttpServer } from "effect/http";

export const BUS_SERVER_NAME = "cerium";
export const BUS_PATH = "/mcp";

/**
 * Per-agent bus credentials. Every session gets its own bearer token, so a tool call always knows
 * which agent made it; tokens die with the agent's session.
 */
export class BusRegistry extends Context.Service<
  BusRegistry,
  BusEndpoint["Service"] & {
    agentFor(token: string): Option.Option<AgentId>;
  }
>()("cerium/bus/BusRegistry") {
  /** Needs the bus's `HttpServer` to know the URL sessions should call. */
  static readonly layer = Layer.effect(
    BusRegistry,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const crypto = yield* Crypto.Crypto;
      const url = `${HttpServer.formatAddress(server.address)}${BUS_PATH}`;
      const agents = new Map<string, AgentId>();
      const tokens = new Map<AgentId, string>();

      return BusRegistry.of({
        serverName: BUS_SERVER_NAME,
        register: (agentId) =>
          crypto.randomUUIDv4().pipe(
            Effect.orDie,
            Effect.map((token) => {
              agents.set(token, agentId);
              tokens.set(agentId, token);
              return { type: "http" as const, url, headers: { Authorization: `Bearer ${token}` } };
            }),
          ),
        unregister: (agentId) =>
          Effect.sync(() => {
            const token = tokens.get(agentId);
            tokens.delete(agentId);
            if (token !== undefined) agents.delete(token);
          }),
        agentFor: (token) => Option.fromNullishOr(agents.get(token)),
      });
    }),
  );

  /** The orchestrator's view of the registry. */
  static readonly endpoint = Layer.effect(
    BusEndpoint,
    Effect.gen(function* () {
      return BusEndpoint.of(yield* BusRegistry);
    }),
  );
}
