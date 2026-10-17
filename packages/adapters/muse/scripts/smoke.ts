// Live end-to-end check of the Muse adapter against the user's installed `muse`.
//
// Usage (from the repo root):
//   node packages/adapters/muse/scripts/smoke.ts          needs `muse login`: a read + an approved write,
//                                                         a reply after an effort switch (checking Cerium's
//                                                         appended instructions), a trusted MCP call plus a
//                                                         denied command, an interrupted turn, then a resume
//   node packages/adapters/muse/scripts/smoke.ts --echo   no account: Muse's offline `echo` provider runs two
//                                                         turns with Cerium's bus injected, then a resume

import type { AdapterEvent, AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Fiber, Option, Stream } from "effect";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMuseExecutable, MuseAdapter, startMuseSession } from "../src/index.ts";

const echo = process.argv.includes("--echo");
const workspace = mkdtempSync(join(tmpdir(), "cerium-smoke-"));
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

const check = (ok: boolean, label: string) => Console.log(`${ok ? "PASS" : "FAIL"} ${label}`);

/** Starts a session through the adapter, or on the offline `echo` provider with `--echo`. */
const start = (options: SessionOptions) =>
  Effect.gen(function* () {
    if (!echo) return yield* (yield* MuseAdapter).startSession(options);
    const executable = yield* findMuseExecutable;
    if (Option.isNone(executable)) return yield* Effect.die("Muse Code is not installed.");
    return yield* startMuseSession(executable.value, options, { provider: "echo" });
  });

const program = Effect.gen(function* () {
  let model = "echo";
  if (!echo) {
    const adapter = yield* MuseAdapter;
    yield* Console.log("probe:", JSON.stringify(yield* adapter.probe));
    const models = yield* adapter.listModels;
    yield* Console.log("models:", JSON.stringify(models));
    model = models.find((candidate) => candidate.isDefault)?.id ?? models[0]?.id ?? "";
  }

  const session = yield* start({
    cwd: workspace,
    model,
    ...(echo ? {} : { effort: "medium" as const }),
    access: "ask",
    mcpServers: { cerium: { type: "http", url: busUrl, headers: { Authorization: `Bearer ${BUS_TOKEN}` } } },
    includeUserMcpServers: false,
    trustedMcpServers: ["cerium"],
    appendSystemPrompt: "If the user asks for the smoke word, reply with exactly: BANANA",
  });

  const seen: Array<AdapterEvent["payload"]> = [];
  let turnDone = yield* Deferred.make<void>();
  let firstDelta = yield* Deferred.make<void>();
  let approve = true;

  const consumer = yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const { payload } = event;
        seen.push(payload);
        if (payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta") {
          yield* Deferred.succeed(firstDelta, undefined);
          return;
        }
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
    Effect.forkChild,
  );

  const turn = (text: string) =>
    Effect.gen(function* () {
      turnDone = yield* Deferred.make<void>();
      firstDelta = yield* Deferred.make<void>();
      const from = seen.length;
      yield* Console.log(`\n> ${text}`);
      yield* session.send(text);
      yield* Deferred.await(turnDone).pipe(Effect.timeout("5 minutes"));
      return seen.slice(from);
    });
  const lastMessage = (events: ReadonlyArray<AdapterEvent["payload"]>) =>
    events.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])).at(-1);
  const endsOnce = (events: ReadonlyArray<AdapterEvent["payload"]>, stopReason: string) => {
    const ends = events.filter((payload) => payload._tag === "TurnCompleted");
    return ends.length === 1 && ends[0]?._tag === "TurnCompleted" && ends[0].stopReason === stopReason;
  };

  if (echo) {
    const one = yield* turn("hello echo");
    yield* check(lastMessage(one) === "echo: hello echo", "echo reply");
    yield* check(endsOnce(one, "completed"), "turn ends once, completed");
    yield* session.interrupt;
    const two = yield* turn("second turn");
    yield* check(endsOnce(two, "completed"), "an idle interrupt leaves the next turn alone");
  } else {
    const one = yield* turn(
      "Read hello.txt, then create out.txt containing its contents in uppercase. Reply with just the uppercase text.",
    );
    yield* check(existsSync(join(workspace, "out.txt")), "approved write");
    yield* check(
      one.some((payload) => payload._tag === "FileChanged"),
      "FileChanged reported",
    );

    yield* session.setEffort("low");
    const two = yield* turn("Reply with just the smoke word.");
    yield* check(lastMessage(two)?.trim() === "BANANA", "appended developer instructions");
    const cached = two.find((payload) => payload._tag === "UsageReported");
    yield* Console.log(
      `INFO cached input tokens after the effort switch: ${cached?._tag === "UsageReported" ? (cached.cachedInputTokens ?? 0) : "none reported"}`,
    );

    approve = false;
    const three = yield* turn(
      "Call the ping tool of the `cerium` MCP server. Then run the shell command " +
        "`New-Item -ItemType File denied.txt` (it needs approval; I will deny it). Then reply with just DONE.",
    );
    yield* check(busCalls.length === 1, "trusted MCP tool ran");
    yield* check(
      three
        .filter((payload) => payload._tag === "PermissionRequested")
        .every((payload) => !payload.toolName.startsWith("mcp__")),
      "trusted MCP tool did not ask",
    );
    yield* check(!existsSync(join(workspace, "denied.txt")), "denied command did not run");
    yield* check(three.at(-1)?._tag === "TurnCompleted", "turn after a denial completed");

    const interrupted = yield* Effect.gen(function* () {
      turnDone = yield* Deferred.make<void>();
      firstDelta = yield* Deferred.make<void>();
      const from = seen.length;
      yield* session.send("Write a 400-word story about a lighthouse keeper.");
      yield* Deferred.await(firstDelta);
      yield* session.interrupt;
      yield* Deferred.await(turnDone);
      return seen.slice(from);
    });
    yield* check(endsOnce(interrupted, "interrupted"), "interrupt ends the turn once, as interrupted");
  }

  const started = seen.find((payload) => payload._tag === "SessionStarted");
  const sessionId = started?._tag === "SessionStarted" ? started.providerSessionId : "";
  yield* Fiber.interrupt(consumer);
  yield* Console.log(
    "\nusage per turn:",
    JSON.stringify(seen.filter((payload) => payload._tag === "UsageReported")),
  );
  return { sessionId, model };
}).pipe(Effect.scoped);

/** Resumes the session on a fresh host and reads its first event, without sending a turn. */
const resume = ({ sessionId, model }: { readonly sessionId: string; readonly model: string }) =>
  Effect.gen(function* () {
    const session: AgentSession = yield* start({
      cwd: workspace,
      model,
      access: "ask",
      mcpServers: {},
      includeUserMcpServers: false,
      resume: sessionId,
    });
    const [first] = yield* session.events.pipe(Stream.take(1), Stream.runCollect);
    yield* check(
      first?.payload._tag === "SessionStarted" && first.payload.providerSessionId === sessionId,
      `resume keeps the session id (${sessionId})`,
    );
  }).pipe(Effect.scoped);

const main = program.pipe(
  Effect.flatMap(resume),
  Effect.provide(MuseAdapter.layer),
  Effect.provide(NodeServices.layer),
  Effect.ensuring(Effect.sync(() => bus.close())),
);

NodeRuntime.runMain(main);
