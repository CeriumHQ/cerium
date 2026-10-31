// Live end-to-end check of the Grok Build adapter against the user's installed, signed-in `grok`.
// It spends a little of the plan's usage.
//
// Usage (from the repo root): node packages/adapters/grok/scripts/smoke.ts [model]
//
// Checks, each printed PASS or FAIL:
//   probe, models, usage meters, skills
//   a session with a stand-in for Cerium's bus over HTTP: Cerium's appended instructions, an effort
//   switch, a read, an approved write, a trusted MCP call that asks nothing, a denied command, an
//   interrupted turn, a manual compaction
//   a side question while the session is open (`/btw`), then a fork before the second turn
//   a resume on a fresh process, a completion, and the user's sessions listed and one read back
// Signed out, it stops after the probe and says so.

import type { AdapterEvent, AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Fiber, Stream } from "effect";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrokAdapter } from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-grok-smoke-"));
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
  Effect.sync(() => {
    if (!ok) failures++;
  }).pipe(Effect.andThen(Console.log(`${ok ? "PASS" : "FAIL"} ${label}`)));

const program = Effect.gen(function* () {
  const adapter = yield* GrokAdapter;
  const status = yield* adapter.probe;
  yield* Console.log("probe:", JSON.stringify(status));
  if (status._tag !== "HarnessInstalled") return yield* check(false, "Grok Build is installed");
  if (status.auth._tag !== "LoggedIn") {
    yield* Console.log("Grok Build is signed out: run `grok login`, then run this again.");
    return;
  }
  const models = yield* adapter.listModels;
  yield* Console.log("models:", JSON.stringify(models));
  yield* check(models.length > 0, "lists models");
  const model = process.argv[2] ?? models.find((each) => each.isDefault)?.id ?? models[0]!.id;
  const offered = models.find((each) => each.id === model);
  if (adapter.usage) yield* Console.log("usage:", JSON.stringify(yield* adapter.usage.pipe(Effect.result)));
  if (adapter.listSkills)
    yield* Console.log("skills:", JSON.stringify(yield* adapter.listSkills(workspace).pipe(Effect.result)));

  const options: SessionOptions = {
    cwd: workspace,
    model,
    ...(offered?.efforts.includes("low") ? { effort: "low" as const } : {}),
    access: "ask",
    mcpServers: { cerium: { type: "http", url: busUrl, headers: { Authorization: `Bearer ${BUS_TOKEN}` } } },
    includeUserMcpServers: false,
    trustedMcpServers: ["cerium"],
    appendSystemPrompt: "If the user asks for the smoke word, reply with exactly: BANANA",
  };

  const { sessionId } = yield* Effect.gen(function* () {
    const session: AgentSession = yield* adapter.startSession(options);
    const seen: Array<AdapterEvent["payload"]> = [];
    let turnDone = yield* Deferred.make<void>();
    let firstText = yield* Deferred.make<void>();
    let approve = true;
    const consumer = yield* session.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const { payload } = event;
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
        yield* Deferred.await(turnDone).pipe(Effect.timeout("4 minutes"));
        return seen.slice(from);
      });
    const replyOf = (payloads: ReadonlyArray<AdapterEvent["payload"]>) =>
      payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])).join("\n");

    const started = seen.find((payload) => payload._tag === "SessionStarted");
    const id = started?._tag === "SessionStarted" ? started.providerSessionId : "";
    yield* check(id !== "", `session started (${id})`);

    yield* check(
      replyOf(yield* turn("What is the smoke word?")).includes("BANANA"),
      "Cerium's appended instructions reach Grok",
    );
    if (offered?.efforts.includes("high")) yield* session.setEffort("high");
    const read = yield* turn("Read hello.txt and tell me exactly what it says.");
    yield* check(replyOf(read).includes("hello from cerium"), "a read");
    const wrote = yield* turn("Create a file named out.txt containing exactly: smoke ok");
    yield* check(
      existsSync(join(workspace, "out.txt")) &&
        readFileSync(join(workspace, "out.txt"), "utf8").includes("smoke ok"),
      "an approved write",
    );
    yield* check(
      wrote.some((payload) => payload._tag === "FileChanged"),
      "the write reports the file it changed",
    );
    const mcp = yield* turn("Call the cerium ping tool and tell me what it returned.");
    yield* check(busCalls.length > 0, "Cerium's injected HTTP MCP server is called");
    yield* check(
      !mcp.some((payload) => payload._tag === "PermissionRequested"),
      "a trusted server's tool asks nothing",
    );
    approve = false;
    const denied = yield* turn("Run the shell command `touch denied.txt`.");
    yield* check(!existsSync(join(workspace, "denied.txt")), "a denied command doesn't run");
    yield* check(
      denied.some((payload) => payload._tag === "PermissionRequested"),
      "the command asked first",
    );
    approve = true;
    yield* check(
      seen.some((payload) => payload._tag === "UsageReported"),
      "turns report usage",
    );

    if (adapter.sideQuestion) {
      const answer = yield* adapter
        .sideQuestion({
          cwd: workspace,
          model,
          sessionId: id,
          instructions: "Answer in one line.",
          prompt: "What file did you create in this conversation?",
        })
        .pipe(Effect.result);
      yield* Console.log("side question:", JSON.stringify(answer));
      yield* check(
        answer._tag === "Success" && answer.success.includes("out.txt"),
        "a side question sees the session",
      );
    }

    turnDone = yield* Deferred.make<void>();
    firstText = yield* Deferred.make<void>();
    yield* session.send("Count slowly from 1 to 200, one number per line.");
    yield* Deferred.await(firstText).pipe(Effect.timeout("2 minutes"));
    yield* session.interrupt;
    yield* Deferred.await(turnDone).pipe(Effect.timeout("1 minute"));
    const last = seen.findLast((payload) => payload._tag === "TurnCompleted");
    yield* check(
      last?._tag === "TurnCompleted" && last.stopReason === "interrupted",
      "interrupt ends the turn",
    );

    if (session.compact) {
      turnDone = yield* Deferred.make<void>();
      yield* session.compact;
      yield* Deferred.await(turnDone).pipe(Effect.timeout("4 minutes"));
      yield* check(
        seen.some((payload) => payload._tag === "ContextCompacted"),
        "a manual compaction",
      );
    }
    yield* Fiber.interrupt(consumer);
    return { sessionId: id };
  }).pipe(Effect.scoped);

  if (adapter.fork) {
    const copy = yield* adapter.fork({ cwd: workspace, sessionId, before: { index: 1 } }).pipe(Effect.result);
    yield* Console.log("fork:", JSON.stringify(copy));
    yield* check(copy._tag === "Success" && copy.success !== sessionId, "a fork before the second turn");
  }

  yield* Effect.gen(function* () {
    const resumed = yield* adapter.startSession({ ...options, resume: sessionId });
    const [first] = yield* resumed.events.pipe(Stream.take(1), Stream.runCollect);
    yield* check(
      first?.payload._tag === "SessionStarted" && first.payload.providerSessionId === sessionId,
      "resume keeps the session id",
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

  if (adapter.listSessions && adapter.readSession) {
    const sessions = yield* adapter.listSessions;
    yield* check(sessions.length > 0, `lists the user's sessions (${sessions.length})`);
    const ours = sessions.find((session) => session.id === sessionId) ?? sessions[0];
    if (ours) {
      const history = yield* adapter.readSession(ours);
      yield* check(history.turns.length > 0, `reads a session back (${history.turns.length} turns)`);
    }
  }
});

const main = program.pipe(
  Effect.provide(GrokAdapter.layer),
  Effect.provide(NodeServices.layer),
  Effect.ensuring(
    Effect.sync(() => {
      bus.close();
      if (failures > 0) process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(main);
