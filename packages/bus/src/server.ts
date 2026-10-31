import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { createServer } from "node:http";

import { BrowserTools } from "./browser.ts";
import { ComputerTools } from "./computer.ts";
import { ArtifactPreviewTool } from "./preview.ts";
import { BUS_PATH, BUS_SERVER_NAME, BusRegistry } from "./registry.ts";
import { BusToolkit, ChildToolkit, BusToolkitHandlers } from "./tools.ts";

/** Loopback only, on a free port: the bus is reachable from this machine's harness processes alone. */
export const BusHttpServer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });

/** What every session's MCP client is told the server is for, at initialize. */
const INSTRUCTIONS =
  "Cerium tools for agent coordination, project runs, browser checks, computer use and artifacts.";

/**
 * The MCP endpoint's routes, for serving alongside other routes. Requires the Orchestrator,
 * BusRegistry, BrowserHost, PushHost, UserSettings and Computer.
 */
const LeadRoutes = Layer.mergeAll(
  McpServer.toolkit(BusToolkit),
  ArtifactPreviewTool,
  BrowserTools,
  ComputerTools,
).pipe(
  Layer.provide(BusToolkitHandlers),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: BUS_SERVER_NAME,
      version: "0.0.0",
      instructions: INSTRUCTIONS,
      path: BUS_PATH,
      // Newest first; older harness MCP clients negotiate down.
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    }),
  ),
);

const ChildRoutes = Layer.mergeAll(
  McpServer.toolkit(ChildToolkit),
  Layer.fresh(ArtifactPreviewTool),
  Layer.fresh(BrowserTools),
  Layer.fresh(ComputerTools),
).pipe(
  Layer.provide(BusToolkitHandlers),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: BUS_SERVER_NAME,
      version: "0.0.0",
      instructions: INSTRUCTIONS,
      path: `${BUS_PATH}/child`,
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    }),
  ),
  Layer.fresh,
);

export const BusRoutes = Layer.mergeAll(LeadRoutes, ChildRoutes);

/** The MCP endpoint served on its own, on `BusHttpServer`. */
export const BusServer = HttpRouter.serve(BusRoutes, { disableListenLog: true, disableLogger: true });

/** Registry plus the orchestrator-facing endpoint, both bound to the bus's HTTP server. */
export const BusRegistryLive = BusRegistry.endpoint.pipe(Layer.provideMerge(BusRegistry.layer));
