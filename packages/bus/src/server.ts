import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { createServer } from "node:http";

import { BUS_PATH, BUS_SERVER_NAME, BusRegistry } from "./registry.ts";
import { BusToolkit, BusToolkitHandlers } from "./tools.ts";

/** Loopback only, on a free port: the bus is reachable from this machine's harness processes alone. */
export const BusHttpServer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });

/** What every session's MCP client is told the server is for, at initialize. */
const INSTRUCTIONS = [
  "Cerium's own tools.",
  "Agents: spawn and stop agents in your thread (spawn_agent, list_agents, kill_agent), and message them or" +
    " another thread's lead (send_message, list_threads), before changing files they work on or to ask what they know." +
    " A lead answers its children's permission requests with answer_permission.",
  "Advisor: ask_advisor puts a question to the user's advisor model when you are stuck; its answer arrives as a message.",
  "Artifacts: artifact_guide before writing your first visual.",
].join("\n");

/** The MCP endpoint's routes, for serving alongside other routes. Requires the Orchestrator and BusRegistry. */
export const BusRoutes = McpServer.toolkit(BusToolkit).pipe(
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

/** The MCP endpoint served on its own, on `BusHttpServer`. */
export const BusServer = HttpRouter.serve(BusRoutes, { disableListenLog: true, disableLogger: true });

/** Registry plus the orchestrator-facing endpoint, both bound to the bus's HTTP server. */
export const BusRegistryLive = BusRegistry.endpoint.pipe(Layer.provideMerge(BusRegistry.layer));
