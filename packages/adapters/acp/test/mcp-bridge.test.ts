import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The stdio bridge against an MCP server on Effect's Streamable HTTP transport, the one Cerium's bus
// serves: an agent's MCP client on one side, the server and its bearer token on the other.

const Echo = Tool.make("echo", {
  description: "Returns the text, and the token it was called with.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});
const Tools = Toolkit.make(Echo);
const Handlers = Tools.toLayer({
  echo: ({ text }) =>
    Effect.gen(function* () {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
      const token = Option.match(request, {
        onNone: () => "none",
        onSome: (http) => http.headers["authorization"] ?? "none",
      });
      return `${text} (${token})`;
    }),
});

const Server = HttpRouter.serve(
  McpServer.toolkit(Tools).pipe(
    Layer.provide(Handlers),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "bridged",
        version: "0.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      }),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })));

const bridge = join(import.meta.dirname, "..", "src", "mcp-bridge.ts");

type Message = { readonly id?: number; readonly result?: any; readonly error?: { readonly message: string } };

/** Runs the bridge to `url`, sends `messages` one answer at a time, and gathers the answers. */
const talk = (url: string, messages: ReadonlyArray<Record<string, unknown>>) =>
  new Promise<{ readonly answers: ReadonlyArray<Message>; readonly exitCode: number | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [bridge, url], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, CERIUM_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer agent-token" }) },
      });
      const answers: Array<Message> = [];
      const queue = [...messages];
      const next = () => {
        const message = queue.shift();
        if (message === undefined) return child.stdin.end();
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
        // A notification has no answer to wait for.
        if (message["id"] === undefined) next();
      };
      createInterface({ input: child.stdout }).on("line", (line) => {
        answers.push(JSON.parse(line) as Message);
        next();
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => resolve({ answers, exitCode }));
      next();
    },
  );

describe("MCP bridge", () => {
  it.live("carries an MCP session over stdio to a Streamable HTTP server, with its headers", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const url = `${HttpServer.formatAddress(server.address)}/mcp`;
      const { answers, exitCode } = yield* Effect.promise(() =>
        talk(url, [
          {
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "agent", version: "0.0.0" },
            },
          },
          { method: "notifications/initialized" },
          { id: 2, method: "tools/list", params: {} },
          { id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } },
          { id: 4, method: "tools/call", params: { name: "missing", arguments: {} } },
        ]),
      );
      assert.deepStrictEqual(
        answers.map((answer) => answer.id),
        [1, 2, 3, 4],
      );
      assert.strictEqual(answers[0]!.result.serverInfo.name, "bridged");
      assert.deepStrictEqual(
        answers[1]!.result.tools.map((tool: { name: string }) => tool.name),
        ["echo"],
      );
      assert.strictEqual(answers[2]!.result.content[0].text, "hello (Bearer agent-token)");
      assert.isTrue(answers[3]!.error !== undefined || answers[3]!.result?.isError === true);
      // Its stdin closed, the bridge ends its session and exits.
      assert.strictEqual(exitCode, 0);
    }).pipe(Effect.provide(Server), Effect.scoped, Effect.timeout("30 seconds")),
  );

  it.live("answers each request with an error when the server can't be reached", () =>
    Effect.gen(function* () {
      const { answers } = yield* Effect.promise(() =>
        talk("http://127.0.0.1:9/mcp", [
          { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
          { method: "notifications/initialized" },
        ]),
      );
      assert.lengthOf(answers, 1);
      assert.strictEqual(answers[0]!.id, 1);
      assert.match(answers[0]!.error!.message, /unreachable/);
    }).pipe(Effect.timeout("30 seconds")),
  );
});
