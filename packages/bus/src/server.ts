import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { createServer } from "node:http";

import { LiveCheckTools } from "./live/tools.ts";
import { BUS_PATH, BUS_SERVER_NAME, BusRegistry } from "./registry.ts";
import { BusToolkit, BusToolkitHandlers } from "./tools.ts";
import { UiDriver } from "./ui/driver.ts";
import { UiTools } from "./ui/tools.ts";

/** Loopback only, on a free port: the bus is reachable from this machine's harness processes alone. */
export const BusHttpServer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });

/** What every session's MCP client is told the server is for, at initialize. */
const INSTRUCTIONS = [
  "Cerium's own tools.",
  "Agents: spawn, message and stop other agents in this thread (spawn_agent, send_message, list_agents, list_threads, kill_agent).",
  "UI: see and use a web UI like a user. ui_open a URL (or attach to an app's debugging port), then ui_act with a batch of" +
    " clicks, typing and key presses, which answers with a screenshot; ui_inspect reads the page's controls and console.",
  "Live checks: live_check runs a short real turn on each harness and reports what it did, instead of a hand-written script.",
  "Artifacts: artifact_guide before writing your first visual.",
].join("\n");

/** The MCP endpoint's routes, for serving alongside other routes. Requires the Orchestrator, Adapters and BusRegistry. */
export const BusRoutes = Layer.mergeAll(
  McpServer.toolkit(BusToolkit).pipe(Layer.provide(BusToolkitHandlers)),
  UiTools.pipe(Layer.provide(UiDriver.layer)),
  LiveCheckTools,
).pipe(
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
