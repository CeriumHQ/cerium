import type { AgentSession } from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  AcpTranslator,
  makeAcpSession,
  makeConfigState,
  openSession,
  readConfigOptions,
  record,
  type AcpConnection,
  type AcpSessionOptions,
} from "../src/index.ts";
import { fixture, run } from "./support.ts";

const start = (acp: AcpConnection, options: Partial<AcpSessionOptions> = {}) =>
  Effect.gen(function* () {
    const opened = record(yield* openSession(acp, "session/new", { cwd: "/", mcpServers: [] }));
    const sessionId = String(opened?.["sessionId"]);
    const session = yield* makeAcpSession({
      acp,
      sessionId,
      translator: new AcpTranslator({ provider: "devin" }),
      ...options,
    });
    const config = makeConfigState({ acp, sessionId, initial: readConfigOptions(opened?.["configOptions"]) });
    return { session, config };
  });

type Session = Effect.Success<ReturnType<typeof start>>["session"];
type Answer = "allow" | "deny" | "interrupt" | "ignore";

/** Sends a turn and collects its events through `TurnCompleted`, answering each approval as told. */
const turn = (session: Session, text: string, answer: Answer = "ignore") =>
  Effect.gen(function* () {
    yield* session.send(text, undefined, () => Effect.succeed({ model: "fixture-a" }));
    return yield* collect(session, answer);
  });

const collect = (
  session: Pick<AgentSession, "events" | "respondToPermission" | "interrupt">,
  answer: Answer,
) =>
  session.events.pipe(
    Stream.tap(({ payload }) => {
      if (payload._tag !== "PermissionRequested" || answer === "ignore") return Effect.void;
      if (answer === "interrupt") return session.interrupt;
      return session.respondToPermission(payload.requestId, { decision: answer, scope: "session" });
    }),
    Stream.map(({ payload }) => payload),
    Stream.takeUntil((payload) => payload._tag === "TurnCompleted"),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
  );

const texts = (payloads: ReadonlyArray<EventPayload>) =>
  payloads.flatMap((payload) => (payload._tag === "MessageCompleted" ? [payload.text] : []));

describe("ACP session", () => {
  it("serializes native compaction with prompts and reports success and refusal as turns", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp);
        yield* session.compact("_fixture/compact", {}, () => "fixture-a");
        const busy = yield* Effect.flip(
          session.send("overlap", undefined, () => Effect.succeed({ model: "fixture-a" })),
        );
        expect(busy.message).toContain("turn is still running");
        expect(yield* collect(session, "ignore")).toEqual([
          { _tag: "ContextCompacted", trigger: "manual" },
          { _tag: "TurnCompleted", stopReason: "completed" },
        ]);
        yield* session.compact("_fixture/compact", { refuse: true }, () => "fixture-a");
        expect(yield* collect(session, "ignore")).toMatchObject([
          { _tag: "AgentError", message: expect.stringContaining("Compaction unavailable") },
          { _tag: "TurnCompleted", stopReason: "error" },
        ]);
      }),
    ));

  it("translates a turn's updates and reports its usage and stop reason", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp);
        const payloads = yield* turn(session, "hello");
        expect(payloads.map(({ _tag }) => _tag)).toEqual([
          "ReasoningDelta",
          "ReasoningCompleted",
          "MessageDelta",
          "MessageDelta",
          "MessageCompleted",
          "ToolCallStarted",
          "ToolCallCompleted",
          "FileChanged",
          "TodosUpdated",
          "ContextReported",
          "UsageReported",
          "TurnCompleted",
        ]);
        expect(payloads).toContainEqual(expect.objectContaining({ _tag: "MessageCompleted", text: "Hello" }));
        expect(payloads).toContainEqual({ _tag: "FileChanged", path: "/repo/a.ts", change: "created" });
        expect(payloads).toContainEqual({
          _tag: "UsageReported",
          provider: "devin",
          model: "fixture-a",
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 2,
        });
        expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
      }),
    ));

  it("grants and refuses one call at a time, never an agent's lasting grant", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp);
        const allowed = yield* turn(session, "approve", "allow");
        expect(allowed).toContainEqual(
          expect.objectContaining({
            _tag: "PermissionRequested",
            toolName: "execute",
            summary: "Run tests",
            input: { command: "npm test" },
          }),
        );
        expect(allowed).toContainEqual(
          expect.objectContaining({ _tag: "PermissionResolved", decision: "allow", scope: "once" }),
        );
        expect(texts(allowed)).toEqual(["selected:once"]);

        const denied = yield* turn(session, "approve", "deny");
        expect(denied).toContainEqual(
          expect.objectContaining({ _tag: "PermissionResolved", decision: "deny" }),
        );
        expect(texts(denied)).toEqual(["selected:reject"]);

        // Offered only a lasting grant, the default handler refuses without asking.
        const lasting = yield* turn(session, "always", "allow");
        expect(lasting.some(({ _tag }) => _tag === "PermissionRequested")).toBe(false);
        expect(texts(lasting)).toEqual(["cancelled"]);
      }),
    ));

  it("cancels pending approvals on interrupt and reports the turn interrupted", () =>
    run(
      Effect.gen(function* () {
        const { acp, received } = yield* fixture();
        const { session } = yield* start(acp);
        const payloads = yield* turn(session, "wait", "interrupt");
        expect(payloads).toContainEqual(
          expect.objectContaining({ _tag: "PermissionResolved", decision: "deny", scope: "once" }),
        );
        expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
        // The agent can finish the cancelled turn before reading the approval reply. The next
        // prompt is queued after that reply, so its completion confirms both reached the agent.
        expect(texts(yield* turn(session, "again"))).toEqual(["again"]);
        const messages = yield* received;
        expect(messages.some(({ method }) => method === "session/cancel")).toBe(true);
        expect(messages.find(({ id }) => id === "client-1")?.result).toEqual({
          outcome: { outcome: "cancelled" },
        });
      }),
    ));

  it("denies an approval the user leaves unanswered past the timeout", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp, { approvalTimeout: "50 millis" });
        const payloads = yield* turn(session, "approve");
        expect(payloads).toContainEqual(
          expect.objectContaining({ _tag: "PermissionResolved", decision: "deny" }),
        );
        expect(texts(payloads)).toEqual(["selected:reject"]);
      }),
    ));

  it("routes the agent's other requests to the harness's handlers", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp, {
          requests: {
            "fixture/hook": (id, params, current) =>
              acp.respond(id, { accepting: current.accepting(params), active: current.isActive() }),
          },
        });
        expect(texts(yield* turn(session, "hook"))).toEqual(['{"accepting":true,"active":true}']);
      }),
    ));

  it("reports sign-outs, refusals and stops it doesn't know as the turn's failure", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp);
        const signedOut = yield* turn(session, "auth");
        expect(signedOut).toEqual([
          {
            _tag: "AuthRequired",
            provider: "devin",
            reason: "Fixture is not signed in.",
            loginCommand: "fixture login",
          },
          { _tag: "TurnCompleted", stopReason: "error" },
        ]);
        expect(yield* turn(session, "refuse")).toEqual([
          {
            _tag: "AgentError",
            kind: "unknown",
            message: "Fixture stopped the turn without completing it",
            retryable: false,
          },
          { _tag: "TurnCompleted", stopReason: "error" },
        ]);
      }),
    ));

  it("ends the turn and the stream when the agent exits mid-turn", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp, { idleExitMessage: "Should not show." });
        const payloads = yield* turn(session, "die");
        expect(payloads).toEqual([
          {
            _tag: "AgentError",
            kind: "unknown",
            message: "The Fixture ACP process exited",
            retryable: false,
          },
          { _tag: "TurnCompleted", stopReason: "error" },
        ]);
        expect(yield* Stream.runCollect(session.events)).toEqual([]);
        expect(
          yield* Effect.flip(session.send("more", undefined, () => Effect.succeed({ model: "fixture-a" }))),
        ).toMatchObject({ message: "The Fixture ACP process exited" });
      }),
    ));

  it("ends the stream on an idle exit, saying so when the harness asks", () =>
    run(
      Effect.gen(function* () {
        const quiet = yield* start((yield* fixture()).acp);
        yield* quiet.session.acp.notify("fixture/exit", {});
        expect(yield* Stream.runCollect(quiet.session.events)).toEqual([]);

        const told = yield* start((yield* fixture()).acp, { idleExitMessage: "The agent exited." });
        yield* told.session.acp.notify("fixture/exit", {});
        expect((yield* Stream.runCollect(told.session.events)).map(({ payload }) => payload)).toEqual([
          { _tag: "AgentError", kind: "unknown", message: "The agent exited.", retryable: false },
        ]);
      }),
    ));

  it("keeps session changes between turns and sends images and _meta with the prompt", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const { session } = yield* start(acp);
        yield* session.send("hang", undefined, () => Effect.succeed({ model: "fixture-a" }));
        expect(yield* Effect.flip(session.whenIdle(Effect.void))).toMatchObject({
          message: "A Fixture turn is still running",
        });
        expect(
          yield* Effect.flip(session.send("again", undefined, () => Effect.succeed({ model: "fixture-a" }))),
        ).toMatchObject({ message: "A Fixture turn is still running" });
        yield* session.interrupt;
        expect((yield* collect(session, "ignore")).at(-1)).toEqual({
          _tag: "TurnCompleted",
          stopReason: "interrupted",
        });

        const image = { path: "/unused.png", mediaType: "image/png", data: "eA==" };
        yield* session.send("ignored", { images: [image, image] }, () =>
          Effect.succeed({ model: "fixture-a", text: "images", meta: { turn: 1 } }),
        );
        expect(texts(yield* collect(session, "ignore"))).toEqual(['2 images, meta {"turn":1}']);
      }),
    ));

  it("refuses images the agent doesn't accept", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture({ ACP_FIXTURE_IMAGES: "0" });
        const { session } = yield* start(acp);
        const image = { path: "/unused.png", mediaType: "image/png", data: "eA==" };
        expect(
          yield* Effect.flip(
            session.send("x", { images: [image] }, () => Effect.succeed({ model: "fixture-a" })),
          ),
        ).toMatchObject({ message: "This Fixture CLI does not accept images" });
      }),
    ));

  it("closes the session when its scope closes between turns, unless the harness opts out", () =>
    run(
      Effect.gen(function* () {
        const closing = yield* fixture();
        yield* Effect.scoped(start(closing.acp));
        expect((yield* closing.received).some(({ method }) => method === "session/close")).toBe(true);

        const kept = yield* fixture();
        yield* Effect.scoped(start(kept.acp, { closeOnExit: false }));
        expect((yield* kept.received).some(({ method }) => method === "session/close")).toBe(false);
      }),
    ));

  it("fails to open a session for a signed-out CLI with the harness's loggedOut", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture({ ACP_FIXTURE_LOGGED_OUT: "1" });
        expect(
          yield* Effect.flip(openSession(acp, "session/new", { cwd: "/", mcpServers: [] })),
        ).toMatchObject({
          _tag: "HarnessUnavailable",
          provider: "devin",
          reason: "loggedOut",
          message: "Fixture is not signed in.",
        });
      }),
    ));
});

describe("ACP session config", () => {
  it("switches offered values, checks the agent applied them, and refuses others", () =>
    run(
      Effect.gen(function* () {
        const { acp, received } = yield* fixture();
        const { config } = yield* start(acp);
        expect(config.current("model")).toMatchObject({ currentValue: "fixture-a" });
        expect(config.current("model")?.options[1]).toEqual({ value: "fixture-b", name: "FIXTURE-B" });
        yield* config.set("model", "fixture-b");
        expect(config.current("model")?.currentValue).toBe("fixture-b");

        const changes = () =>
          received.pipe(
            Effect.map((all) => all.filter(({ method }) => method === "session/set_config_option")),
          );
        // An unchanged value isn't sent.
        yield* config.set("model", "fixture-b");
        expect(yield* changes()).toHaveLength(1);

        expect(yield* Effect.flip(config.set("model", "missing"))).toMatchObject({
          message: "Fixture does not offer missing for model in this session",
        });
        expect(yield* Effect.flip(config.set("model", "stubborn"))).toMatchObject({
          message: "Fixture did not apply stubborn for model",
        });
      }),
    ));

  it("leaves checking the value to the agent for harnesses that don't list them", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const opened = record(yield* openSession(acp, "session/new", { cwd: "/", mcpServers: [] }));
        const config = makeConfigState({
          acp,
          sessionId: "fixture-session",
          initial: readConfigOptions(opened?.["configOptions"]),
          requireOffered: false,
        });
        expect(yield* Effect.flip(config.set("effort", "high"))).toMatchObject({
          message: "Fixture refused `session/set_config_option`: No option effort",
        });
        yield* config.set("mode", "auto");
        expect(config.current("mode")?.currentValue).toBe("auto");
      }),
    ));
});
