import { portable, type AgentSession, type SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import assert from "node:assert/strict";
import { join } from "node:path";

import { GrokAdapter } from "../src/index.ts";

const options: SessionOptions = {
  cwd: process.cwd(),
  model: "grok-fixture",
  effort: "low",
  access: "ask",
  includeUserMcpServers: false,
  mcpServers: {
    cerium: { type: "http", url: "http://127.0.0.1:9512/mcp", headers: { Authorization: "Bearer fixture" } },
  },
  trustedMcpServers: ["cerium"],
  appendSystemPrompt: "fixture instructions",
};

const collect = (session: AgentSession, answer?: "allow" | "deny" | "cancel") =>
  session.events.pipe(
    Stream.tap(({ payload }) => {
      if (payload._tag !== "PermissionRequested") return Effect.void;
      if (answer === "cancel") return session.interrupt;
      if (answer) {
        return session.respondToPermission(payload.requestId, { decision: answer, scope: "session" });
      }
      return Effect.die("Unexpected permission prompt");
    }),
    Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
    Stream.map(({ payload }) => payload),
    Stream.runCollect,
  );

const test = Effect.gen(function* () {
  const adapter = yield* GrokAdapter;
  const status = yield* adapter.probe;
  assert.equal(status._tag, "HarnessInstalled");
  assert(!JSON.stringify(status).includes("discard-this"));
  if (process.env.GROK_TEST_LOGOUT) {
    assert.deepEqual(status.auth, { _tag: "LoggedOut", loginCommand: "grok login" });
    const models = yield* Effect.flip(adapter.listModels);
    assert.equal(models._tag, "HarnessUnavailable");
    assert.equal(models.reason, "loggedOut");
    console.log("PASS provider-local login required");
    return;
  }
  assert.deepEqual(status.auth, { _tag: "LoggedIn", method: "grokLogin" });
  const models = yield* adapter.listModels;
  assert.deepEqual(models[0]?.efforts, ["low", "high"]);
  assert.equal(models[0]?.defaultEffort, "high");
  console.log("PASS install, provider auth, and model catalog");

  const hub = adapter.hub;
  assert(hub);
  assert(
    typeof hub.addServer === "function" &&
      typeof hub.setServer === "function" &&
      typeof hub.skillsFolder === "function",
  );
  assert(typeof adapter.listSkills === "function" && typeof hub.status === "function");
  assert.deepEqual(yield* hub.status(options.cwd), []);
  const listing = yield* hub.read(options.cwd);
  const remote = listing.servers[0];
  assert(remote);
  assert.deepEqual(remote.headers, [
    { name: "Authorization", set: true },
    { name: "X-Empty", set: false },
  ]);
  assert(!JSON.stringify(listing).includes("fixture-secret"));
  assert.deepEqual(yield* adapter.listSkills(options.cwd), [
    {
      name: "review",
      description: "Review changes",
      path: join(options.cwd, ".grok", "skills", "review", "SKILL.md"),
    },
  ]);
  assert.equal(yield* hub.skillsFolder(options.cwd, "project"), join(options.cwd, ".grok", "skills"));
  assert.equal(
    yield* hub.addServer(options.cwd, "project", portable(remote)),
    join(options.cwd, ".grok", "config.toml"),
  );
  assert.equal(
    (yield* Effect.flip(hub.addServer(options.cwd, "user", portable(remote))))._tag,
    "HubConflict",
  );
  yield* hub.setServer(options.cwd, remote, false);
  console.log("PASS native Grok config, skill discovery, toggles and blank MCP copies");

  assert(adapter.listSessions);
  assert(
    typeof adapter.readSession === "function" &&
      typeof adapter.fork === "function" &&
      typeof adapter.sideQuestion === "function",
  );
  const saved = (yield* adapter.listSessions)[0];
  assert(saved?.cwd);
  assert.equal(saved.title, "Saved Grok");
  const history = yield* adapter.readSession(saved);
  assert.equal(history.model, "grok-fixture");
  assert.equal(history.turns[0]?.prompt, "Imported prompt");
  assert.equal(history.turns[0]?.events.at(-1)?.payload._tag, "MessageCompleted");
  assert.equal(
    yield* adapter.fork({ cwd: saved.cwd, sessionId: saved.id, before: { index: 2 } }),
    "forked-grok",
  );
  assert.equal(
    yield* adapter.fork({ cwd: saved.cwd, sessionId: saved.id, through: { index: 1 } }),
    "forked-grok",
  );
  assert.equal(
    yield* adapter.fork({ cwd: saved.cwd, sessionId: saved.id, before: { index: 0 } }),
    "empty-fork",
  );
  assert.equal(
    yield* adapter.sideQuestion({
      cwd: saved.cwd,
      sessionId: saved.id,
      model: "grok-fixture",
      instructions: "Only reference the transcript.",
      prompt: "What happened?",
    }),
    "The original session stayed put.",
  );
  console.log("PASS session imports, turn-boundary forks and side questions");

  const previous = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession({ ...options, includeUserMcpServers: true });
      assert.deepEqual(yield* hub.status!(options.cwd), [
        { name: "remote", connection: "connected", tools: [{ name: "echo", description: "Echo text" }] },
        { name: "pending", connection: "starting" },
      ]);
      yield* session.send("first", {
        turnId: "fixture-turn",
        images: [{ path: "fixture.png", mediaType: "image/png", data: "YWJj" }],
      });
      const events = yield* collect(session, "deny");
      const start = events[0];
      assert(start?._tag === "SessionStarted");
      assert(events.some((e) => e._tag === "ReasoningCompleted" && e.text === "thinking"));
      assert(events.some((e) => e._tag === "ToolCallStarted" && e.toolName === "run_terminal_cmd"));
      assert(events.some((e) => e._tag === "PermissionRequested" && e.summary === "touch marker"));
      assert(
        events.some((e) => e._tag === "PermissionResolved" && e.decision === "deny" && e.scope === "once"),
      );
      assert(events.some((e) => e._tag === "ToolCallCompleted" && e.isError));
      assert(events.some((e) => e._tag === "MessageCompleted" && e.text === "DENIED"));
      assert(
        events.some((e) => e._tag === "UsageReported" && e.inputTokens === 30 && e.cachedInputTokens === 70),
      );
      assert.deepEqual(events.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
      console.log("PASS ACP streaming, images, MCP injection, approval and token usage");

      yield* session.send("allow this");
      const allowed = yield* collect(session, "allow");
      assert(
        allowed.some((e) => e._tag === "PermissionResolved" && e.decision === "allow" && e.scope === "once"),
      );
      yield* session.send("always-only");
      const refused = yield* collect(session, "allow");
      assert(refused.some((e) => e._tag === "PermissionResolved" && e.decision === "deny"));
      console.log("PASS one-time approvals never select persistent ACP options");

      yield* session.setModel("grok-other");
      yield* session.send("cancel this");
      const cancelled = yield* collect(session, "cancel");
      assert(cancelled.some((e) => e._tag === "PermissionResolved" && e.decision === "deny"));
      assert(cancelled.some((e) => e._tag === "UsageReported" && e.model === "grok-other"));
      assert.deepEqual(cancelled.at(-1), { _tag: "TurnCompleted", stopReason: "interrupted" });
      console.log("PASS model switch and cancellation while awaiting permission");

      assert(session.compact && typeof session.stopBackgroundTask === "function");
      yield* session.compact;
      const compacted = yield* collect(session);
      assert.deepEqual(compacted, [
        { _tag: "ContextCompacted", trigger: "manual" },
        { _tag: "TurnCompleted", stopReason: "completed" },
      ]);
      const changed = session.events.pipe(
        Stream.filter(({ payload }) => payload._tag === "BackgroundTasksChanged"),
        Stream.take(1),
        Stream.runCollect,
      );
      yield* session.send("background fixture");
      const started = (yield* changed)[0]?.payload;
      assert.deepEqual(started, {
        _tag: "BackgroundTasksChanged",
        tasks: [
          {
            id: "task-fixture",
            kind: "command",
            command: "sleep 40",
            description: "Wait",
            startedAt: 20002,
            stoppable: true,
          },
        ],
      });
      yield* session.stopBackgroundTask("task-fixture");
      assert.deepEqual((yield* changed)[0]?.payload, { _tag: "BackgroundTasksChanged", tasks: [] });
      console.log("PASS explicit compaction and background task lifecycle");
      return start.providerSessionId;
    }),
  );
  assert.deepEqual(yield* hub.status(options.cwd), []);

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* adapter.startSession({ ...options, access: "readOnly", resume: previous });
      yield* session.send("resumed");
      const events = yield* collect(session);
      assert(events[0]?._tag === "SessionStarted" && events[0].providerSessionId === previous);
      assert(!JSON.stringify(events).includes("old history"));
      assert(events.some((e) => e._tag === "MessageCompleted" && e.text === "DENIED"));
      assert.deepEqual(events.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
      yield* session.send("exit unexpectedly");
      const exited = yield* collect(session);
      assert(exited.some((e) => e._tag === "AgentError"));
      assert.deepEqual(exited.at(-1), { _tag: "TurnCompleted", stopReason: "error" });
      assert.deepEqual(yield* Stream.runCollect(session.events), []);
      console.log("PASS cold resume, read-only denial, and process exit");
    }),
  );
});

NodeRuntime.runMain(
  test.pipe(
    Effect.timeout("20 seconds"),
    Effect.provide(GrokAdapter.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
);
