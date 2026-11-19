import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type { AgentSession } from "@cerium/harness";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { createServer } from "node:http";
import { once } from "node:events";

import { AntigravityAdapter } from "../src/index.ts";

const marker = "cerium-antigravity-mcp-verified";

const startFixtureMcp = Effect.acquireRelease(
  Effect.promise(async () => {
    const calls: Array<{ method: string; expectedHeader: boolean }> = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({ method, expectedHeader: request.headers["x-cerium-fixture"] === "local-test" });
      if (id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = {
        initialize: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Cerium fixture", version: "1.0.0" },
        },
        "tools/list": {
          tools: [
            {
              name: "read_marker",
              description: "Return the string stored in the local fixture. This tool only reads.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
        "tools/call": { content: [{ type: "text", text: marker }] },
      }[String(method)];
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...(result === undefined ? { error: { code: -32601, message: "Unknown method" } } : { result }),
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The MCP fixture did not bind");
    return { server, url: `http://127.0.0.1:${address.port}/mcp`, calls };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
);

const turn = (session: AgentSession, prompt: string) =>
  Effect.gen(function* () {
    yield* session.send(prompt);
    const events = yield* session.events.pipe(
      Stream.tap(({ payload }) => {
        if (payload._tag !== "PermissionRequested") return Effect.void;
        return session.respondToPermission(payload.requestId, {
          decision: payload.toolName === "mcp_fixture_read_marker" ? "allow" : "deny",
          scope: "once",
        });
      }),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
      Effect.timeout("90 seconds"),
    );
    const payloads = events.map(({ payload }) => payload);
    console.log("ACP events", payloads.map(({ _tag }) => _tag).join(" "));
    return payloads;
  });

describe.skipIf(process.env["CERIUM_ANTIGRAVITY_LIVE"] !== "1")("Installed Antigravity CLI", () => {
  it("uses the installed CLI to call an injected MCP tool and resume its conversation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const status = yield* adapter.probe;
        expect(status).toMatchObject({ _tag: "HarnessInstalled", auth: { _tag: "LoggedIn" } });
        if (status._tag !== "HarnessInstalled") throw new Error("Install and sign in to agy first");

        const models = yield* adapter.listModels;
        const model =
          models.find(({ id }) => id === "gemini-3.8-flash") ??
          models.find(({ id }) => id.includes("flash")) ??
          models[0];
        if (model === undefined) throw new Error("The signed-in account has no Antigravity model");
        console.log("Installed CLI", status.version, "catalog size", models.length, "model", model.id);
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-antigravity-live-" });
        const mcp = yield* startFixtureMcp;
        const options = {
          cwd,
          model: model.id,
          effort: "minimal",
          access: "ask",
          includeUserMcpServers: true,
          mcpServers: {
            fixture: { type: "http", url: mcp.url, headers: { "X-Cerium-Fixture": "local-test" } },
          },
          appendSystemPrompt:
            "This is an isolated Cerium fixture. Only call the named fixture tool when asked.",
        } as const;

        const resume = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options);
            const events = yield* turn(
              session,
              "Use mcp_fixture_read_marker and reply with its output. Do not use any other tools.",
            );
            expect(events).toContainEqual(
              expect.objectContaining({
                _tag: "PermissionResolved",
                decision: "allow",
                scope: "once",
              }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({
                _tag: "MessageCompleted",
                text: expect.stringContaining(marker),
              }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({
                _tag: "UsageReported",
                inputTokens: expect.any(Number),
                outputTokens: expect.any(Number),
              }),
            );
            expect(events.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
            const started = events.find((payload) => payload._tag === "SessionStarted");
            if (started === undefined) throw new Error("The fixture session did not start");
            return started.providerSessionId;
          }),
        );
        expect(mcp.calls).toContainEqual({ method: "tools/call", expectedHeader: true });
        console.log("Local fixture MCP calls", mcp.calls.map(({ method }) => method).join(" "));

        const resumed = yield* adapter.startSession({ ...options, resume });
        const events = yield* turn(
          resumed,
          "Reply with the fixture marker you already received. Do not use tools.",
        );
        expect(events[0]).toMatchObject({ _tag: "SessionStarted", providerSessionId: resume });
        expect(events).toContainEqual(
          expect.objectContaining({
            _tag: "MessageCompleted",
            text: expect.stringContaining(marker),
          }),
        );
        expect(events.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
      }).pipe(
        Effect.scoped,
        Effect.provide(AntigravityAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ));
});
