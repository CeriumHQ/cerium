// Live end-to-end check of the Codex adapter against the user's installed, logged-in `codex`.
// Runs four short turns on the cheapest listed model: a read + an approved write, a reply after an
// effort switch (checking Cerium's appended instructions and the prompt cache), a trusted MCP call
// plus a denied command, and an interrupted turn. Then it resumes the thread and checks its id.
//
// Usage: node packages/adapters/codex/scripts/smoke.ts [--unelevated-sandbox]
//
// `--unelevated-sandbox` runs Codex's Windows sandbox unelevated for this run only, for machines where
// the elevated sandbox's setup refresh fails (seen while the Codex desktop app's computer-use helper
// holds a runtime DLL open: every command then fails with "setup refresh had errors").

import type { AdapterEvent, AgentSession } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/index.ts";

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

/** Adds the unelevated-sandbox override to every `codex app-server` the adapter spawns. */
const UnelevatedSandbox = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      spawner.spawn(
        command._tag === "StandardCommand" && command.args[0] === "app-server"
          ? ChildProcess.make(
              command.command,
              [...command.args, "-c", 'windows.sandbox="unelevated"'],
              command.options,
            )
          : command,
      ),
    );
  }),
);

const check = (ok: boolean, label: string) => Console.log(`${ok ? "PASS" : "FAIL"} ${label}`);

const program = Effect.gen(function* () {
  const adapter = yield* CodexAdapter;
  yield* Console.log("probe:", JSON.stringify(yield* adapter.probe));
  const models = yield* adapter.listModels;
  yield* Console.log("models:", JSON.stringify(models));
  const model = models.find((candidate) => candidate.id.includes("luna"))?.id ?? models[0]?.id ?? "";

  const session = yield* adapter.startSession({
    cwd: workspace,
    model,
    effort: "medium",
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
      yield* Deferred.await(turnDone);
      return seen.slice(from);
    });

  const lastMessage = (events: ReadonlyArray<AdapterEvent["payload"]>) =>
    events.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])).at(-1);
  const usage = (events: ReadonlyArray<AdapterEvent["payload"]>) =>
    events.find((payload) => payload._tag === "UsageReported");
  const sessionId = () => {
    const started = seen.find((payload) => payload._tag === "SessionStarted");
    return started?._tag === "SessionStarted" ? started.providerSessionId : "";
  };

  const one = yield* turn(
    "Read hello.txt, then use apply_patch to create out.txt containing its contents in uppercase. " +
      "Reply with just the uppercase text.",
  );
  const written = existsSync(join(workspace, "out.txt"));
  yield* check(
    written && readFileSync(join(workspace, "out.txt"), "utf8").includes("HELLO FROM CERIUM"),
    "approved write",
  );
  yield* check(
    one.some((payload) => payload._tag === "FileChanged"),
    "FileChanged reported",
  );

  yield* session.setEffort("low");
  const two = yield* turn("Reply with just the smoke word.");
  yield* check(lastMessage(two)?.trim() === "BANANA", "appended developer instructions");
  // Cached-token counts vary from run to run, so the cache-keeping switch is checked by the
  // `configuration_update` item Codex writes to the thread's rollout. Only GPT-6 models take one.
  if (model.startsWith("gpt-6")) {
    const sessions = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "sessions");
    const rollout = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((file) =>
      file.endsWith(`${sessionId()}.jsonl`),
    );
    yield* check(
      rollout !== undefined &&
        readFileSync(join(sessions, rollout), "utf8").includes('"type":"configuration_update"'),
      "effort switch sent as a configuration_update",
    );
  }
  const cached = usage(two);
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
  const completions = interrupted.filter((payload) => payload._tag === "TurnCompleted");
  yield* check(
    completions.length === 1 &&
      completions[0]?._tag === "TurnCompleted" &&
      completions[0].stopReason === "interrupted",
    "interrupt ends the turn once, as interrupted",
  );

  const threadId = sessionId();
  yield* Fiber.interrupt(consumer);
  yield* Console.log(
    "\nusage per turn:",
    JSON.stringify(seen.filter((payload) => payload._tag === "UsageReported")),
  );
  return { threadId, model };
}).pipe(Effect.scoped);

/** Resumes the thread in a fresh process and reads its first event, without sending a turn. */
const resume = ({ threadId, model }: { readonly threadId: string; readonly model: string }) =>
  Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const session: AgentSession = yield* adapter.startSession({
      cwd: workspace,
      model,
      access: "ask",
      mcpServers: {},
      includeUserMcpServers: false,
      resume: threadId,
    });
    const [first] = yield* session.events.pipe(Stream.take(1), Stream.runCollect);
    yield* check(
      first?.payload._tag === "SessionStarted" && first.payload.providerSessionId === threadId,
      `resume keeps the thread id (${threadId})`,
    );
  }).pipe(Effect.scoped);

const main = program.pipe(
  Effect.flatMap(resume),
  Effect.provide(CodexAdapter.layer),
  Effect.provide(process.argv.includes("--unelevated-sandbox") ? UnelevatedSandbox : Layer.empty),
  Effect.provide(NodeServices.layer),
  Effect.ensuring(Effect.sync(() => bus.close())),
);

NodeRuntime.runMain(main);
