import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { createServer } from "node:http";

import { BUS_PATH, BUS_SERVER_NAME, BusRegistry } from "./registry.ts";
import { BusToolkit, BusToolkitHandlers } from "./tools.ts";

/** Loopback only, on a free port: the bus is reachable from this machine's harness processes alone. */
export const BusHttpServer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });

/** The MCP endpoint with the bus tools, served on `BusHttpServer`. Requires the Orchestrator and BusRegistry. */
export const BusServer = HttpRouter.serve(
  McpServer.toolkit(BusToolkit).pipe(
    Layer.provide(BusToolkitHandlers),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: BUS_SERVER_NAME,
        version: "0.0.0",
        instructions: "Coordinate with other agents in Cerium.",
        path: BUS_PATH,
        // Newest first; older harness MCP clients negotiate down.
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      }),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
);

/** Registry plus the orchestrator-facing endpoint, both bound to the bus's HTTP server. */
export const BusRegistryLive = BusRegistry.endpoint.pipe(Layer.provideMerge(BusRegistry.layer));
