import type { AgentSession } from "@cerium/harness";
import { Effect, Fiber, Stream } from "effect";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// The pieces the Copilot end-to-end tests share: the fixture CLI, and a loopback model and MCP server
// for running the real CLI offline (`CERIUM_COPILOT_E2E_CLI`).

export const fixture = fileURLToPath(new URL("./fixtures/copilot.mjs", import.meta.url));
export const liveCli = process.env["CERIUM_COPILOT_E2E_CLI"];

export interface ModelRequest {
  model: string;
  stream?: boolean;
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  tools?: ReadonlyArray<{ function: { name: string } }>;
}

export const startModel = (calls: Array<ModelRequest>) =>
  Effect.suspend(() => {
    const server = modelServer(calls);
    return Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (address !== null && typeof address !== "string")
                resolve(`http://127.0.0.1:${address.port}/v1`);
            });
          }),
      ),
      () =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
  });

export const image = {
  path: "fixture.png",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
};

export function modelServer(calls: Array<ModelRequest>) {
  return createServer(async (request, response) => {
    const body: Array<Uint8Array> = [];
    for await (const chunk of request) body.push(chunk);
    const input: unknown = body.length === 0 ? null : JSON.parse(Buffer.concat(body).toString("utf8"));
    if (request.url === "/mcp") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const rpc = input as { id?: number; method: string; params?: { protocolVersion: string } };
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const results = {
        initialize: {
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-mcp", version: "1.0.0" },
        },
        "tools/list": {
          tools: [{ name: "echo", description: "Echo a fixture response", inputSchema: { type: "object" } }],
        },
        "tools/call": { content: [{ type: "text", text: "fixture MCP reply" }] },
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: results[rpc.method as keyof typeof results] ?? {},
        }),
      );
      return;
    }
    const call = input as ModelRequest;
    calls.push(call);
    const latest = call.messages.findLast(({ role }) => role === "user");
    const file = /write ([a-z-]+\.txt)/.exec(JSON.stringify(latest?.content ?? ""))?.[1];
    const write =
      file !== undefined &&
      call.tools?.some(({ function: tool }) => tool.name === "create") === true &&
      call.messages.at(-1)?.role !== "tool";
    if (call.stream !== true) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chat_helper",
          object: "chat.completion",
          created: 1,
          model: call.model,
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture reply" } },
          ],
          usage: { prompt_tokens: 24, completion_tokens: 3, total_tokens: 27 },
        }),
      );
      return;
    }
    const echo =
      !write &&
      JSON.stringify(latest?.content ?? "").includes("ping bus") &&
      call.tools?.some(({ function: tool }) => tool.name === "cerium-echo") === true &&
      call.messages.at(-1)?.role !== "tool";
    const tool = write
      ? { name: "create", arguments: JSON.stringify({ path: file, file_text: "fixture" }) }
      : echo
        ? { name: "cerium-echo", arguments: "{}" }
        : undefined;
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      {
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${calls.length}`,
                      type: "function",
                      function: tool,
                    },
                  ],
                }
              : { content: "fixture reply" },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 24,
          completion_tokens: 3,
          total_tokens: 27,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) {
      response.write(
        `data: ${JSON.stringify({
          id: `chat_fixture_${calls.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: call.model,
          ...chunk,
        })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
}

export const turn = (
  session: AgentSession,
  prompt: string,
  decision?: "allow" | "deny" | "interrupt",
  extras?: Parameters<AgentSession["send"]>[1],
) =>
  Effect.gen(function* () {
    const observer = yield* session.events.pipe(
      Stream.tap(({ payload }) => {
        if (payload._tag !== "PermissionRequested") return Effect.void;
        if (decision === "interrupt") return session.interrupt;
        if (decision === undefined) throw new Error(`Unexpected prompt ${payload.summary}`);
        return session.respondToPermission(payload.requestId, { decision, scope: "once" });
      }),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* session.send(prompt, extras);
    return (yield* Fiber.join(observer)).map(({ payload }) => payload);
  });

/** Sets environment variables for the enclosing scope, restoring them as it closes. */
export const withVariables = (variables: Readonly<Record<string, string | undefined>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
      for (const [name, value] of Object.entries(variables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );
