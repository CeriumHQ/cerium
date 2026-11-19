import { NodeServices } from "@effect/platform-node";
import type { AgentSession, SessionOptions } from "@cerium/harness";
import { Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

import { CopilotAdapter } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/copilot.mjs", import.meta.url));
const liveCli = process.env["CERIUM_COPILOT_E2E_CLI"];

interface ModelRequest {
  model: string;
  stream?: boolean;
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  tools?: ReadonlyArray<{ function: { name: string } }>;
}

const startModel = (calls: Array<ModelRequest>) =>
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

const image = {
  path: "fixture.png",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
};

function modelServer(calls: Array<ModelRequest>) {
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

const turn = (
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

it.skipIf(process.platform === "win32")(
  "drives Copilot through the installed-executable adapter boundary",
  async () => {
    const calls: Array<ModelRequest> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-copilot-e2e-" });
        const cwd = join(root, "workspace");
        yield* fs.makeDirectory(cwd);
        yield* fs.writeFileString(join(cwd, "AGENTS.md"), "Fixture project instructions");
        yield* fs.symlink(fixture, join(root, "copilot"));
        const modelUrl = liveCli ? yield* startModel(calls) : undefined;
        const trace = process.env["CERIUM_COPILOT_E2E_EVIDENCE"] ?? join(root, "trace.jsonl");
        yield* fs.writeFileString(trace, "");
        const copilotHome = join(root, ".copilot");
        if (modelUrl !== undefined) {
          yield* fs.makeDirectory(copilotHome);
          yield* fs.writeFileString(
            join(copilotHome, "mcp-config.json"),
            JSON.stringify({
              mcpServers: {
                personal: { type: "http", url: modelUrl.replace("/v1", "/mcp"), tools: ["*"] },
              },
            }),
          );
        }
        const variables: Record<string, string | undefined> = {
          PATH: `${root}${delimiter}${process.env["PATH"] ?? ""}`,
          COPILOT_HOME: copilotHome,
          GH_CONFIG_DIR: join(root, ".gh"),
          COPILOT_OFFLINE: "true",
          COPILOT_PROVIDER_BASE_URL: modelUrl,
          COPILOT_MODEL: "gpt-4o",
          COPILOT_ALLOW_ALL: "true",
          COPILOT_GITHUB_TOKEN: undefined,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          CERIUM_COPILOT_E2E_TRACE: trace,
          CERIUM_COPILOT_E2E_MODEL_URL: modelUrl,
          CERIUM_COPILOT_E2E_LOGOUT: "true",
        };
        yield* Effect.acquireRelease(
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

        const adapter = yield* CopilotAdapter;
        expect(yield* adapter.probe).toMatchObject({
          _tag: "HarnessInstalled",
          executablePath: join(root, "copilot"),
          auth: { _tag: "LoggedOut", loginCommand: "copilot login" },
        });
        expect(yield* adapter.listModels.pipe(Effect.flip)).toMatchObject({ reason: "loggedOut" });
        delete process.env["CERIUM_COPILOT_E2E_LOGOUT"];
        expect(yield* adapter.listModels).toMatchObject([
          { id: "fixture/gpt-4o", efforts: [] },
          { id: "fixture/gpt-4.1", efforts: ["low", "high"], defaultEffort: "high" },
        ]);

        const options: SessionOptions = {
          cwd,
          model: "fixture/gpt-4o",
          access: "ask",
          mcpServers: {
            cerium: { type: "http", url: modelUrl?.replace("/v1", "/mcp") ?? "http://127.0.0.1/mcp" },
          },
          trustedMcpServers: ["cerium"],
          includeUserMcpServers: false,
          appendSystemPrompt: "Fixture appended instructions",
        };
        const sessionId = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options);
            const denied = yield* turn(session, "write denied.txt", "deny");
            expect(denied).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", decision: "deny" }),
            );
            expect(yield* fs.exists(join(cwd, "denied.txt"))).toBe(false);
            const allowed = yield* turn(session, "write allowed.txt", "allow", { turnId: "fixture-turn" });
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", decision: "allow" }),
            );
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "FileChanged", change: "created" }),
            );
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "MessageDelta", text: "fixture reply" }),
            );
            expect(allowed.filter(({ _tag }) => _tag === "TurnCompleted")).toEqual([
              { _tag: "TurnCompleted", stopReason: "completed" },
            ]);
            expect(allowed).toContainEqual(
              expect.objectContaining({
                _tag: "UsageReported",
                cachedInputTokens: liveCli ? 8 : 4,
                inputTokens: liveCli ? 40 : 20,
              }),
            );
            expect((yield* fs.readFileString(join(cwd, "allowed.txt"))).trim()).toBe("fixture");
            const bus = yield* turn(session, "ping bus", undefined, { images: [image] });
            if (liveCli) {
              expect(bus).toContainEqual(
                expect.objectContaining({ _tag: "ToolCallStarted", toolName: "mcp__cerium__echo" }),
              );
              expect(bus).toContainEqual(
                expect.objectContaining({
                  _tag: "ToolCallCompleted",
                  isError: false,
                  output: expect.stringContaining("fixture MCP reply"),
                }),
              );
            }
            const interrupted = yield* turn(session, "write interrupted.txt", "interrupt");
            expect(interrupted.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
            expect(yield* fs.exists(join(cwd, "interrupted.txt"))).toBe(false);
            const opened = denied.find(({ _tag }) => _tag === "SessionStarted");
            expect(opened?._tag).toBe("SessionStarted");
            return opened?._tag === "SessionStarted" ? opened.providerSessionId : "";
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const resumed = yield* adapter.startSession({
              ...options,
              resume: sessionId,
              access: "readOnly",
            });
            yield* resumed.setModel("fixture/gpt-4.1");
            if (!liveCli) yield* resumed.setEffort("low");
            const events = yield* turn(resumed, "write read-only.txt");
            expect(events).toContainEqual(
              expect.objectContaining({ _tag: "SessionStarted", providerSessionId: sessionId }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({ _tag: "MessageCompleted", text: "fixture reply" }),
            );
            expect(yield* fs.exists(join(cwd, "read-only.txt"))).toBe(false);
          }),
        );

        if (liveCli) {
          expect(calls[0]?.tools?.map(({ function: tool }) => tool.name)).not.toContain("personal-echo");
          const readOnly = calls.at(-1)?.tools?.map(({ function: tool }) => tool.name) ?? [];
          expect(readOnly.sort()).toEqual(["cerium-echo", "glob", "grep", "view"]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const withPersonal = yield* adapter.startSession({
                ...options,
                includeUserMcpServers: true,
                access: "acceptEdits",
              });
              yield* turn(withPersonal, "write automatically.txt");
              expect(yield* fs.exists(join(cwd, "automatically.txt"))).toBe(true);
            }),
          );
          expect(calls.at(-1)?.tools?.map(({ function: tool }) => tool.name)).toContain("personal-echo");
        }

        expect(
          yield* adapter.complete({
            cwd,
            model: "fixture/gpt-4o",
            instructions: "Fixture helper prompt",
            prompt: "write helper.txt",
          }),
        ).toBe("fixture reply");
        expect(yield* fs.exists(join(cwd, "helper.txt"))).toBe(false);

        const requests = (yield* fs.readFileString(trace))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session.send",
            params: expect.objectContaining({ clientTurnId: "fixture-turn" }),
          }),
        );
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session.resume",
            params: expect.objectContaining({
              sessionId,
              continuePendingWork: false,
              tools: expect.objectContaining({
                availableTools: ["builtin:view", "builtin:glob", "builtin:grep", "mcp:*"],
              }),
            }),
          }),
        );
        const helperSession = requests.find(({ method }) => method === "session.delete")?.params?.sessionId;
        expect(helperSession).toEqual(expect.any(String));
        if (liveCli) {
          expect(yield* fs.exists(join(copilotHome, "session-state", helperSession, "events.jsonl"))).toBe(
            false,
          );
          const helper = calls.at(-1);
          expect(helper?.tools ?? []).toEqual([]);
          expect(helper?.messages[0]?.content).toContain("Fixture helper prompt");
          expect(helper?.messages[0]?.content).not.toContain("Fixture project instructions");
          expect(
            calls.flatMap(({ tools }) => tools ?? []).map(({ function: tool }) => tool.name),
          ).not.toContain("task");
          expect(calls.some(({ messages }) => JSON.stringify(messages).includes(image.data))).toBe(true);
          expect(calls[0]?.messages[0]?.content).toContain("Fixture appended instructions");
          expect(calls[0]?.messages[0]?.content).toContain("Fixture project instructions");
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(CopilotAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    );
  },
);
