/** With Grok Build installed and locally signed in, run from the root:
 *   node packages/adapters/grok/test/live.ts
 */
import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrokAdapter } from "../src/index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cerium-grok-live-")));
const cwd = join(root, "project");
mkdirSync(cwd);
const marker = join(cwd, "marker.txt");
writeFileSync(marker, "VIOLET-BISCUIT\n");
chmodSync(marker, 0o644);
let pings = 0;
const bus = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer grok-smoke");
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) body += chunk;
  const { id, method, params } = JSON.parse(body);
  if (id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const results: Record<string, unknown> = {
    initialize: {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "cerium-smoke", version: "1" },
    },
    "tools/list": {
      tools: [
        { name: "ping", description: "Returns the Cerium MCP marker.", inputSchema: { type: "object" } },
      ],
    },
    "tools/call": { content: [{ type: "text", text: "CERIUM-PONG" }] },
  };
  if (method === "tools/call") pings++;
  if (method === "tools/list") console.log("HTTP MCP catalog requested");
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(method in results
        ? { result: results[method] }
        : { error: { code: -32601, message: "Unsupported" } }),
    }),
  );
});
await new Promise<void>((resolve) => bus.listen(0, "127.0.0.1", resolve));
const address = bus.address();
assert(address !== null && typeof address !== "string");

const turn = (session: AgentSession, prompt: string, allowCommand?: string) =>
  Effect.gen(function* () {
    yield* session.send(prompt);
    return yield* session.events.pipe(
      Stream.tap(({ payload }) => {
        if (payload._tag === "ToolCallStarted") console.log("TOOL", payload.toolName);
        if (payload._tag === "AgentError") console.log("ERROR", payload.message);
        if (payload._tag === "PermissionRequested") {
          const allow = payload.toolName === "run_terminal_cmd" && payload.summary === allowCommand;
          console.log(allow ? "ALLOW" : "DENY", payload.toolName);
          return session.respondToPermission(payload.requestId, {
            decision: allow ? "allow" : "deny",
            scope: "session",
            message: "Smoke test blocked the command.",
          });
        }
        return Effect.void;
      }),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
    );
  });

const program = Effect.gen(function* () {
  const adapter = yield* GrokAdapter;
  const status = yield* adapter.probe;
  assert(status._tag === "HarnessInstalled" && status.auth._tag === "LoggedIn", "Run grok login first");
  const models = yield* adapter.listModels;
  const selected = models.find((entry) => entry.isDefault) ?? models[0];
  assert(selected !== undefined);
  console.log("PASS probe and model catalog", status.version, selected.id, selected.efforts);
  const options = {
    cwd,
    model: selected.id,
    ...(selected.efforts[0] === undefined ? {} : { effort: selected.efforts[0] }),
    access: "ask",
    mcpServers: {
      cerium_smoke: {
        type: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer grok-smoke" },
      },
    },
    trustedMcpServers: ["cerium_smoke"],
    includeUserMcpServers: false,
    appendSystemPrompt: "When asked for the verification code, reply CERIUM-RULE.",
  } satisfies SessionOptions;
  const sessionId = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession(options);
      console.log("Grok ACP session opened");
      const events = yield* turn(
        session,
        `Remember the marker VIOLET-BISCUIT. Use the shell exactly once to run chmod 600 ${marker}. If denied, reply CERIUM-DENIED. Do not try another tool.`,
      );
      const payloads = events.map(({ payload }) => payload);
      const started = payloads.find((p) => p._tag === "SessionStarted");
      assert(started !== undefined);
      assert(
        payloads.some((p) => p._tag === "PermissionRequested" && p.summary.includes("chmod 600")),
        JSON.stringify(payloads.map((p) => p._tag)),
      );
      assert(
        payloads.some((p) => p._tag === "PermissionResolved" && p.decision === "deny" && p.scope === "once"),
      );
      assert.equal(statSync(marker).mode & 0o777, 0o644);
      assert(payloads.some((p) => p._tag === "UsageReported" && p.outputTokens > 0));
      assert(payloads.some((p) => p._tag === "MessageCompleted" && p.text.includes("CERIUM-DENIED")));
      assert.deepEqual(payloads.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
      console.log("PASS streamed reply, denied shell command, and turn usage");

      const allowedCommand = `chmod 600 ${marker}`;
      const approved = yield* turn(
        session,
        `Run this shell command exactly once: ${allowedCommand}. Report the outcome, and do not use other tools.`,
        allowedCommand,
      );
      assert.equal(approved.filter(({ payload }) => payload._tag === "PermissionRequested").length, 1);
      assert(
        approved.some(({ payload }) => payload._tag === "PermissionResolved" && payload.decision === "allow"),
      );
      assert.equal(statSync(marker).mode & 0o777, 0o600);
      chmodSync(marker, 0o644);
      console.log("PASS one scoped approval ran the exact shell command");

      const ping = yield* turn(
        session,
        "Find the cerium_smoke MCP ping tool using search_tool, then invoke it exactly once with use_tool. Reply with its result. If unavailable, reply CERIUM-UNAVAILABLE. Do not use web search.",
      );
      const text = ping
        .flatMap(({ payload }) => (payload._tag === "MessageCompleted" ? [payload.text] : []))
        .join(" ");
      assert(pings > 0, text);
      assert(text.includes("CERIUM-PONG"), text);
      console.log("PASS injected trusted HTTP MCP tool");
      return started.providerSessionId;
    }),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession({ ...options, resume: sessionId, access: "readOnly" });
      const events = yield* turn(
        session,
        "Without calling any tool, what marker did I ask you to remember? Also give the verification code from your instructions.",
      );
      assert(
        events.some(
          ({ payload }) => payload._tag === "SessionStarted" && payload.providerSessionId === sessionId,
        ),
      );
      const text = events
        .flatMap(({ payload }) => (payload._tag === "MessageCompleted" ? [payload.text] : []))
        .join(" ");
      assert(text.includes("VIOLET-BISCUIT"), text);
      assert(text.includes("CERIUM-RULE"), text);
      console.log("PASS cold resume retained history and Cerium instructions");
      const readOnly = yield* turn(
        session,
        `If you have a shell tool, try once to run chmod 600 ${marker}. If you have no shell tool, reply CERIUM-NO-SHELL. Do not use a substitute tool.`,
      );
      assert(!readOnly.some(({ payload }) => payload._tag === "PermissionRequested"));
      assert(
        !readOnly.some(
          ({ payload }) => payload._tag === "ToolCallStarted" && payload.toolName.includes("terminal"),
        ),
      );
      assert.equal(statSync(marker).mode & 0o777, 0o644);
      assert.deepEqual(readOnly.at(-1)?.payload, { _tag: "TurnCompleted", stopReason: "completed" });
      console.log("PASS read-only resume withheld the shell");
    }),
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.timeout("2 minutes"),
    Effect.ensuring(
      Effect.sync(() => {
        bus.close();
        rmSync(root, { recursive: true, force: true });
      }),
    ),
    Effect.provide(GrokAdapter.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
);
