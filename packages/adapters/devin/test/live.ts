/** With the Devin CLI installed and signed in, run from the root (DEVIN_BIN picks a CLI off PATH):
 *   node packages/adapters/devin/test/live.ts
 */
import type { AgentSession, SessionOptions } from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeDevinAdapter } from "../src/index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cerium-devin-live-")));
const cwd = join(root, "project");
mkdirSync(cwd);
let pings = 0;
const bus = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer devin-smoke");
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
assert(address !== null && typeof address === "object");

const turn = (session: AgentSession, text: string, decision: "allow" | "deny" = "allow") =>
  Effect.gen(function* () {
    yield* session.send(text);
    return yield* session.events.pipe(
      Stream.tap(({ payload }) =>
        payload._tag === "PermissionRequested"
          ? Effect.log(`approval: ${payload.toolName} — ${payload.summary} -> ${decision}`).pipe(
              Effect.andThen(session.respondToPermission(payload.requestId, { decision, scope: "once" })),
            )
          : Effect.void,
      ),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
      Effect.timeout("3 minutes"),
      Effect.map((events): ReadonlyArray<EventPayload> => events.map(({ payload }) => payload)),
    );
  });

const reply = (payloads: ReadonlyArray<EventPayload>) =>
  payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : [])).join("\n");

const program = Effect.gen(function* () {
  const adapter = yield* makeDevinAdapter(process.env["DEVIN_BIN"]);
  const status = yield* adapter.probe;
  console.log("status", JSON.stringify(status));
  assert(status._tag === "HarnessInstalled" && status.auth._tag === "LoggedIn");

  let started = Date.now();
  const first = yield* adapter.listModels;
  console.log(
    `first listing: ${first.length} models, ${first.filter(({ efforts }) => efforts.length > 0).length} with efforts, ${Date.now() - started}ms`,
  );
  started = Date.now();
  const second = yield* adapter.listModels;
  console.log(
    `second listing: ${second.filter(({ efforts }) => efforts.length > 0).length} with efforts, ${Date.now() - started}ms`,
  );
  const model =
    second.find(({ id }) => id.startsWith("claude-haiku")) ?? second.find(({ isDefault }) => isDefault);
  assert(model !== undefined);
  console.log("model", JSON.stringify(model));

  const options: SessionOptions = {
    cwd,
    model: model.id,
    ...(model.efforts.length > 0 ? { effort: model.efforts[0]! } : {}),
    access: "ask",
    includeUserMcpServers: false,
    mcpServers: {
      cerium: {
        type: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer devin-smoke" },
      },
    },
    trustedMcpServers: ["cerium"],
    appendSystemPrompt: "When the user says MARCO, answer with exactly POLO-7 and nothing else.",
  };

  const sessionId = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession(options);
      const marco = yield* turn(session, "MARCO");
      const begun = marco.find((payload) => payload._tag === "SessionStarted");
      assert(begun?._tag === "SessionStarted");
      console.log("instructions reply:", reply(marco));
      assert.match(reply(marco), /POLO-7/);

      const work = yield* turn(
        session,
        "Call the ping tool on the cerium MCP server. Then create hello.txt containing hi with your file-writing tool. Reply with the ping result.",
      );
      const tags = work.map(({ _tag }) => _tag);
      console.log("tags:", [...new Set(tags)].join(", "));
      console.log("work reply:", reply(work));
      assert.ok(pings > 0, "Cerium's bus was called without asking");
      assert.ok(
        work.some((payload) => payload._tag === "PermissionRequested"),
        "Ask access sent the write to approval",
      );
      assert.ok(existsSync(join(cwd, "hello.txt")), "the approved write ran");
      assert.ok(work.some((payload) => payload._tag === "FileChanged"));
      assert.ok(work.some((payload) => payload._tag === "UsageReported"));
      return begun.providerSessionId;
    }),
  );

  const resumed = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession({ ...options, resume: sessionId });
      return yield* turn(session, "What exact text did the ping tool return earlier? Reply with just it.");
    }),
  );
  console.log("resumed reply:", reply(resumed));
  assert.match(reply(resumed), /CERIUM-PONG/);

  const readOnly = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession({ ...options, access: "readOnly" });
      return yield* turn(session, "Create blocked.txt containing no, using any tool you have. Be brief.");
    }),
  );
  console.log("read-only reply:", reply(readOnly));
  assert.ok(!existsSync(join(cwd, "blocked.txt")), "read-only wrote nothing");
  assert.ok(!readOnly.some((payload) => payload._tag === "PermissionRequested"));
  console.log("LIVE OK", { sessionId, cwd });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(() => bus.close())));

NodeRuntime.runMain(program);
