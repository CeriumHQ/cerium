// Live end-to-end check of the Antigravity CLI adapter against the user's installed, signed-in `agy`. It
// spends a little of the account's quota.
//
// Usage (from the repo root): node packages/adapters/antigravity/scripts/smoke.ts [model]
//
// Checks, each printed PASS or FAIL: probe, models, usage meters, skills, sessions listed; then a session
// with a stand-in for Cerium's bus over HTTP: Cerium's instructions (its agent's prompt), a read that asks
// nothing, an approved write, a trusted MCP call that asks nothing, a denied command, a native subagent
// refused, an interrupted turn, a model switch; a resume on a new run; a completion. Signed out, it stops
// after the probe and says so. Run it on a Gemini API key or Google Cloud sign-in: Google's terms don't
// cover third-party apps on personal accounts.

import type { AdapterEvent, AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Fiber, Stream } from "effect";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AntigravityAdapter } from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-agy-smoke-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

/** A one-tool MCP server over streamable HTTP (plain JSON replies), standing in for Cerium's bus. */
const BUS_TOKEN = "smoke-token";
const busCalls: Array<string> = [];
const bus = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${BUS_TOKEN}`) return void response.writeHead(401).end();
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    const message = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.id === undefined) return void response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "smoke-bus", version: "0.0.0" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "ping", description: "Returns pong.", inputSchema: { type: "object" } }] }
          : message.method === "tools/call"
            ? (busCalls.push(message.method), { content: [{ type: "text", text: "pong" }] })
            : undefined;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } }
            : { jsonrpc: "2.0", id: message.id, result },
        ),
      );
  });
});
await new Promise<void>((resolve) => bus.listen(0, "127.0.0.1", resolve));
const address = bus.address();
const busUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/mcp`;

let failures = 0;
const check = (ok: boolean, label: string) =>
  Effect.sync(() => void (ok || failures++)).pipe(
    Effect.andThen(Console.log(`${ok ? "PASS" : "FAIL"} ${label}`)),
  );

const program = Effect.gen(function* () {
  const adapter = yield* AntigravityAdapter;
  const status = yield* adapter.probe;
  yield* Console.log("probe:", JSON.stringify(status));
  if (status._tag !== "HarnessInstalled") return yield* check(false, "Antigravity CLI is installed");
  if (status.auth._tag !== "LoggedIn")
    return yield* Console.log("Antigravity CLI is signed out: run `agy`, sign in, then run this again.");
  const models = yield* adapter.listModels;
  yield* Console.log("models:", JSON.stringify(models));
  yield* check(models.length > 0, "lists models");
  const model = process.argv[2] ?? models.find((each) => /flash/i.test(each.id))?.id ?? models[0]!.id;
  if (adapter.usage) yield* Console.log("usage:", JSON.stringify(yield* adapter.usage.pipe(Effect.result)));
  if (adapter.listSkills)
    yield* Console.log("skills:", JSON.stringify(yield* adapter.listSkills(workspace).pipe(Effect.result)));
  if (adapter.listSessions)
    yield* Console.log(
      "sessions:",
      JSON.stringify(yield* adapter.listSessions.pipe(Effect.result)).slice(0, 600),
    );

  const options: SessionOptions = {
    cwd: workspace,
    model,
    access: "ask",
    mcpServers: { cerium: { type: "http", url: busUrl, headers: { Authorization: `Bearer ${BUS_TOKEN}` } } },
    includeUserMcpServers: false,
    trustedMcpServers: ["cerium"],
    appendSystemPrompt: "If the user asks for the smoke word, reply with exactly: BANANA",
  };

  const sessionId = yield* Effect.gen(function* () {
    const session: AgentSession = yield* adapter.startSession(options);
    const seen: Array<AdapterEvent["payload"]> = [];
    let turnDone = yield* Deferred.make<void>();
    let firstText = yield* Deferred.make<void>();
    let approve = true;
    const consumer = yield* session.events.pipe(
      Stream.runForEach(({ payload }) =>
        Effect.gen(function* () {
          seen.push(payload);
          if (payload._tag === "MessageDelta") return yield* Deferred.succeed(firstText, undefined);
          if (payload._tag === "ReasoningDelta") return;
          yield* Console.log("event:", JSON.stringify(payload).slice(0, 300));
          if (payload._tag === "PermissionRequested") {
            yield* session.respondToPermission(payload.requestId, {
              decision: approve ? "allow" : "deny",
              scope: "once",
            });
          }
          if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnDone, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    const turn = (text: string) =>
      Effect.gen(function* () {
        turnDone = yield* Deferred.make<void>();
        firstText = yield* Deferred.make<void>();
        const from = seen.length;
        yield* session.send(text);
        yield* Deferred.await(turnDone).pipe(Effect.timeout("5 minutes"));
        return seen.slice(from);
      });
    const replyOf = (payloads: ReadonlyArray<AdapterEvent["payload"]>) =>
      payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])).join("\n");

    yield* check(
      replyOf(yield* turn("What is the smoke word?")).includes("BANANA"),
      "Cerium's instructions reach the agent",
    );
    const started = seen.find((payload) => payload._tag === "SessionStarted");
    const id = started?._tag === "SessionStarted" ? started.providerSessionId : "";
    yield* check(id !== "", `the first run names the conversation (${id})`);
    const read = yield* turn("Read hello.txt and tell me exactly what it says.");
    yield* check(replyOf(read).includes("hello from cerium"), "a read");
    yield* check(!read.some((payload) => payload._tag === "PermissionRequested"), "a read asks nothing");
    const wrote = yield* turn("Create a file named out.txt containing exactly: smoke ok");
    yield* check(
      wrote.some((payload) => payload._tag === "PermissionRequested"),
      "a write asks Cerium (hook bridge)",
    );
    yield* check(
      existsSync(join(workspace, "out.txt")) &&
        readFileSync(join(workspace, "out.txt"), "utf8").includes("smoke ok"),
      "an approved write",
    );
    const mcp = yield* turn("Call the cerium ping tool and tell me what it returned.");
    yield* check(busCalls.length > 0, "Cerium's injected HTTP MCP server is called");
    yield* check(
      !mcp.some((payload) => payload._tag === "PermissionRequested"),
      "a trusted server's tool asks nothing",
    );
    approve = false;
    yield* turn("Run the shell command `touch denied.txt`.");
    yield* check(!existsSync(join(workspace, "denied.txt")), "a denied command doesn't run");
    approve = true;
    const delegated = yield* turn("Use a subagent to list the files here.");
    const subagents = delegated.flatMap((payload) =>
      payload._tag === "ToolCallStarted" && /subagent/.test(payload.toolName) ? [payload.callId] : [],
    );
    yield* check(
      subagents.every((callId) =>
        delegated.some((each) => each._tag === "ToolCallCompleted" && each.callId === callId && each.isError),
      ),
      "a native subagent is refused",
    );
    yield* check(
      seen.some((payload) => payload._tag === "UsageReported"),
      "runs report usage",
    );

    if (models.length > 1) yield* session.setModel(models.find((each) => each.id !== model)!.id);
    turnDone = yield* Deferred.make<void>();
    firstText = yield* Deferred.make<void>();
    yield* session.send("Count slowly from 1 to 300, one number per line.");
    yield* Deferred.await(firstText).pipe(Effect.timeout("2 minutes"));
    yield* session.interrupt;
    yield* Deferred.await(turnDone).pipe(Effect.timeout("1 minute"));
    const last = seen.findLast((payload) => payload._tag === "TurnCompleted");
    yield* check(
      last?._tag === "TurnCompleted" && last.stopReason === "interrupted",
      "interrupt ends the turn",
    );
    yield* Fiber.interrupt(consumer);
    return id;
  }).pipe(Effect.scoped);

  yield* Effect.gen(function* () {
    const resumed = yield* adapter.startSession({ ...options, resume: sessionId });
    const [first] = yield* resumed.events.pipe(Stream.take(1), Stream.runCollect);
    yield* check(
      first?.payload._tag === "SessionStarted" && first.payload.providerSessionId === sessionId,
      "resume keeps the conversation id",
    );
  }).pipe(Effect.scoped);

  const titled = yield* adapter
    .complete({
      model,
      instructions: "Reply with a three-word title.",
      prompt: "Fixing a flaky login test",
      cwd: workspace,
    })
    .pipe(Effect.result);
  yield* Console.log("complete:", JSON.stringify(titled));
  yield* check(titled._tag === "Success" && titled.success.trim() !== "", "a completion");
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(AntigravityAdapter.layer),
    Effect.provide(NodeServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        bus.close();
        if (failures > 0) process.exitCode = 1;
      }),
    ),
  ),
);
