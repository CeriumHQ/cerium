import type { AgentSession, SessionOptions } from "@cerium/harness";
import { EventPayload } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { join } from "node:path";

import { connect, type AcpCommand } from "../src/connection.ts";
import { startAcpSession, type AcpHarness } from "../src/session.ts";
import { listAcpSessions, readAcpSession } from "../src/sessions.ts";

// The session runner against `fixtures/fake-agent.mjs`, a scripted ACP agent on a real stdio pipe.

const command: AcpCommand = {
  provider: "grok",
  label: "Fake",
  executable: process.execPath,
  args: [join(import.meta.dirname, "fixtures", "fake-agent.mjs")],
};

const harness: AcpHarness = {
  provider: "grok",
  label: "Fake",
  loginCommand: "fake login",
  sessionParams: (options) =>
    options.appendSystemPrompt === "signed out" ? { _meta: { signedOut: true } } : {},
};

const options = (overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  cwd: import.meta.dirname,
  model: "fake-b",
  effort: "high",
  access: "ask",
  mcpServers: { cerium: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  includeUserMcpServers: false,
  trustedMcpServers: ["cerium"],
  ...overrides,
});

/** Sends `text` and gathers the turn's events, answering each one `onEvent` wants to. */
const turn = (
  session: AgentSession,
  text: string,
  onEvent?: (payload: EventPayload) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* session.send(text);
    const events = yield* session.events.pipe(
      Stream.tap((event) => (onEvent === undefined ? Effect.void : onEvent(event.payload))),
      Stream.takeUntil((event) => event.payload._tag === "TurnCompleted"),
      Stream.runCollect,
    );
    return Array.from(events, (event) => event.payload);
  });

type Tag = EventPayload["_tag"];
type Of<T extends Tag> = Extract<EventPayload, { readonly _tag: T }>;

const all = <T extends Tag>(payloads: ReadonlyArray<EventPayload>, tag: T) =>
  payloads.filter((payload): payload is Of<T> => payload._tag === tag);

/** The first `tag` event of a turn, which it must have. */
const first = <T extends Tag>(payloads: ReadonlyArray<EventPayload>, tag: T): Of<T> => {
  const found = all(payloads, tag)[0];
  assert.isDefined(found, `the turn has no ${tag}`);
  return found!;
};

const tags = (payloads: ReadonlyArray<EventPayload>) => payloads.map((payload) => payload._tag);

describe("startAcpSession", () => {
  it.live("rejects an image when the runtime did not negotiate image input", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(
        harness,
        { ...command, env: { FAKE_NO_IMAGES: "1" } },
        options(),
      );
      const result = yield* session
        .send("Inspect this", { images: [{ path: "a.png", mediaType: "image/png", data: "AA==" }] })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.message, "did not negotiate image input");
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );
  it.live("streams a turn on the model and effort asked for, with its usage", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options());
      const payloads = yield* turn(session, "hello");
      for (const payload of payloads) assert.isTrue(Schema.is(EventPayload)(payload), payload._tag);
      const started = first(payloads, "SessionStarted");
      assert.strictEqual(payloads[0], started);
      assert.strictEqual(started.model, "fake-b");
      assert.strictEqual(started.effort, "high");
      assert.strictEqual(first(payloads, "ReasoningCompleted").text, "Thinking");
      assert.strictEqual(first(payloads, "MessageCompleted").text, "Hello");
      assert.deepStrictEqual(all(payloads, "UsageReported"), [
        { _tag: "UsageReported", inputTokens: 60, outputTokens: 10, cachedInputTokens: 40, costUsd: 0.25 },
      ]);
      assert.deepStrictEqual(all(payloads, "ContextReported").at(-1), {
        _tag: "ContextReported",
        tokens: 1200,
        window: 200000,
      });
      assert.deepStrictEqual(payloads.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("asks the user and carries out the answer", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options());
      const payloads = yield* turn(session, "write", (payload) =>
        payload._tag === "PermissionRequested"
          ? session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" })
          : Effect.void,
      );
      const asked = first(payloads, "PermissionRequested");
      assert.strictEqual(asked.toolName, "Write");
      assert.deepInclude(asked.input as object, { path: "a.txt", file_path: "a.txt", content: "x" });
      assert.deepStrictEqual(first(payloads, "PermissionResolved"), {
        _tag: "PermissionResolved",
        requestId: asked.requestId,
        decision: "allow",
        scope: "once",
      });
      assert.deepStrictEqual(all(payloads, "FileChanged"), [
        { _tag: "FileChanged", path: "a.txt", change: "created" },
      ]);
      assert.isFalse(first(payloads, "ToolCallCompleted").isError);
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("refuses edits in a read-only session without asking", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options({ access: "readOnly" }));
      const payloads = yield* turn(session, "write");
      assert.notInclude(tags(payloads), "PermissionRequested");
      assert.notInclude(tags(payloads), "FileChanged");
      assert.isTrue(first(payloads, "ToolCallCompleted").isError);
      assert.deepStrictEqual(payloads.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("runs the trusted bus's tools without asking", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options());
      const payloads = yield* turn(session, "mcp");
      assert.notInclude(tags(payloads), "PermissionRequested");
      assert.strictEqual(first(payloads, "ToolCallStarted").toolName, "mcp__cerium__list_agents");
      const completed = first(payloads, "ToolCallCompleted");
      assert.strictEqual(completed.output, "no agents");
      assert.isFalse(completed.isError);
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("interrupts a turn in flight", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options());
      const payloads = yield* turn(session, "wait", (payload) =>
        payload._tag === "MessageDelta" ? session.interrupt.pipe(Effect.orDie) : Effect.void,
      );
      assert.deepStrictEqual(payloads.at(-1), { _tag: "TurnCompleted", stopReason: "interrupted" });
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("reports a signed-out agent as unavailable", () =>
    Effect.gen(function* () {
      const error = yield* startAcpSession(
        harness,
        command,
        options({ appendSystemPrompt: "signed out" }),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "HarnessUnavailable");
      assert.strictEqual(error._tag === "HarnessUnavailable" ? error.reason : undefined, "loggedOut");
      assert.include(error.message, "fake login");
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("resumes a session without replaying it", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(harness, command, options({ resume: "earlier" }));
      const payloads = yield* turn(session, "hello");
      assert.strictEqual(first(payloads, "SessionStarted").providerSessionId, "earlier");
      assert.lengthOf(all(payloads, "MessageCompleted"), 1);
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );
});

describe("past sessions", () => {
  it.live("lists sessions newest first and reads one's turns", () =>
    Effect.gen(function* () {
      const connection = yield* connect(command);
      const sessions = yield* listAcpSessions(connection, "grok");
      assert.deepStrictEqual(
        sessions.map((session) => [session.id, session.title]),
        [
          ["new", "Untitled session"],
          ["old", "An old one"],
        ],
      );
      const history = yield* readAcpSession(connection, sessions[1]!, { provider: "grok", cwd: "/work" });
      assert.deepStrictEqual(
        history.turns.map((each) => each.prompt),
        ["First question", "Second"],
      );
      const firstTurn = history.turns[0]!.events.map((event) => event.payload);
      assert.deepStrictEqual(tags(firstTurn), ["MessageCompleted"]);
      assert.strictEqual(first(firstTurn, "MessageCompleted").text, "First answer");
      assert.deepStrictEqual(tags(history.turns[1]!.events.map((event) => event.payload)), [
        "ToolCallStarted",
        "ToolCallCompleted",
        "MessageCompleted",
      ]);
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.provide(NodeServices.layer)),
  );
});
