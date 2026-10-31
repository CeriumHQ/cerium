import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { EventPayload } from "@cerium/protocol";
import type { AdapterEvent, AgentSession, SessionOptions } from "@cerium/harness";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpHarness } from "../src/harness.ts";
import { historyFromUpdates } from "../src/history.ts";
import { inspectAcpAgent } from "../src/adapter.ts";
import { modelsFromSetup } from "../src/models.ts";
import { startAcpSession } from "../src/session.ts";
import { openAcpConnection } from "../src/connection.ts";
import { listAcpSessions, readAcpSession } from "../src/history.ts";

// The whole client against `fake-agent.ts`, a scripted ACP agent: the handshake, MCP injection,
// models and efforts, prompts, approvals, cancelling, compaction, resume and history.

const agent = join(import.meta.dirname, "fake-agent.ts");

const harness = (log: string, env: Record<string, string> = {}): AcpHarness => ({
  provider: "grok",
  name: "Fake agent",
  loginCommand: "fake login",
  command: () => ({ args: [agent], env: { FAKE_ACP_LOG: log, ...env } }),
  modeFor: (access, modes) =>
    access === "readOnly" ? modes.find((mode) => mode.id === "read-only")?.id : undefined,
  instructions: "firstPrompt",
  compactCommand: "compact",
  manifest: {
    provider: "grok",
    session: { resume: true, fork: false },
    switching: { model: true, effort: true, cacheSafeEffort: false },
    input: { images: true },
    permissions: { approvals: "protocol", readOnlyMode: true },
    mcpInjection: true,
    nativeSubagents: "disableable",
    usageReporting: "tokensAndCost",
    compact: true,
    defaultConcurrency: 4,
  },
});

const options = (overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  cwd: mkdtempSync(join(tmpdir(), "cerium-acp-")),
  model: "fake-fast",
  access: "ask",
  mcpServers: {
    cerium: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
  },
  includeUserMcpServers: false,
  trustedMcpServers: ["cerium"],
  ...overrides,
});

const freshLog = () => join(mkdtempSync(join(tmpdir(), "cerium-acp-log-")), "requests.jsonl");
const requests = (log: string): Array<{ method: string; params: any }> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

/** Collects a session's events into a queue the test reads turn by turn. */
const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<AdapterEvent>();
    yield* session.events.pipe(
      Stream.runForEach((event) => Queue.offer(seen, event)),
      Effect.ignore,
      Effect.forkScoped,
    );
    /** The events up to and including the next `TurnCompleted`, answering each permission with `answer`. */
    const turn = (
      answer?: (event: Extract<EventPayload, { _tag: "PermissionRequested" }>) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const payloads: Array<EventPayload> = [];
        while (true) {
          const { payload } = yield* Queue.take(seen);
          expect(Schema.is(EventPayload)(payload)).toBe(true);
          payloads.push(payload);
          if (payload._tag === "PermissionRequested" && answer) yield* answer(payload);
          if (payload._tag === "TurnCompleted") return payloads;
        }
      });
    const first = yield* Queue.take(seen);
    return { first: first.payload, turn };
  });

/** Runs a scoped test program on the real platform, as the test's promise. */
const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("startAcpSession against a scripted agent", () => {
  it("injects Cerium's MCP servers, sets model and effort, and streams a turn", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(
          harness(log),
          process.execPath,
          options({ effort: "high", appendSystemPrompt: "Say BANANA." }),
        );
        const { first, turn } = yield* collect(session);
        expect(first).toMatchObject({
          _tag: "SessionStarted",
          provider: "grok",
          providerSessionId: "fake-1",
          model: "fake-fast",
          effort: "high",
        });

        const created = requests(log).find((entry) => entry.method === "session/new");
        expect(created?.params.mcpServers).toEqual([
          {
            type: "http",
            name: "cerium",
            url: "http://127.0.0.1:1/mcp",
            headers: [{ name: "Authorization", value: "Bearer t" }],
          },
        ]);
        expect(
          requests(log).find((entry) => entry.method === "session/set_config_option")?.params,
        ).toMatchObject({
          configId: "reasoning",
          value: "high",
        });

        yield* session.send("hello");
        const payloads = yield* turn();
        expect(payloads.map((payload) => payload._tag)).toEqual([
          "ReasoningDelta",
          "ReasoningCompleted",
          "MessageDelta",
          "MessageDelta",
          "ContextReported",
          "MessageCompleted",
          "UsageReported",
          "TurnCompleted",
        ]);
        expect(payloads.find((payload) => payload._tag === "MessageCompleted")).toMatchObject({
          text: "Hi there",
        });
        expect(payloads.find((payload) => payload._tag === "UsageReported")).toMatchObject({
          inputTokens: 70,
          cachedInputTokens: 30,
          outputTokens: 50,
          costUsd: 0.01,
        });
        expect(payloads.find((payload) => payload._tag === "ContextReported")).toEqual({
          _tag: "ContextReported",
          tokens: 1200,
          window: 200000,
        });
        // Cerium's instructions open the first prompt only.
        const prompts = requests(log).filter((entry) => entry.method === "session/prompt");
        expect(prompts[0]?.params.prompt[0].text).toContain("<cerium-instructions>\nSay BANANA.");

        yield* session.setModel("fake-smart");
        expect(
          requests(log)
            .filter((entry) => entry.method === "session/set_config_option")
            .at(-1)?.params,
        ).toMatchObject({
          configId: "model",
          value: "fake-smart",
        });
      }),
    ));

  it("asks the user, honours the answer, and lets trusted servers through", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(harness(log), process.execPath, options());
        const { turn } = yield* collect(session);

        yield* session.send("edit");
        const allowed = yield* turn((request) =>
          session.respondToPermission(request.requestId, { decision: "allow", scope: "once" }),
        );
        expect(allowed.map((payload) => payload._tag)).toEqual([
          "ToolCallStarted",
          "PermissionRequested",
          "PermissionResolved",
          "ToolCallCompleted",
          "FileChanged",
          "MessageDelta",
          "MessageCompleted",
          "TurnCompleted",
        ]);
        expect(allowed[0]).toMatchObject({ toolName: "edit", input: { path: "/work/hello.txt" } });
        expect(allowed.find((payload) => payload._tag === "FileChanged")).toMatchObject({
          path: "/work/hello.txt",
          change: "modified",
        });
        const answers = () =>
          requests(log)
            .filter((entry) => entry.method === undefined)
            .map((entry) => entry);
        void answers;

        yield* session.send("edit");
        const denied = yield* turn((request) =>
          session.respondToPermission(request.requestId, { decision: "deny", scope: "once" }),
        );
        expect(denied.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: true,
        });
        expect(denied.some((payload) => payload._tag === "FileChanged")).toBe(false);

        // The bus is trusted: its tool runs without asking.
        yield* session.send("mcp");
        const trusted = yield* turn();
        expect(trusted.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(trusted[0]).toMatchObject({ _tag: "ToolCallStarted", toolName: "mcp__cerium__ping" });
        expect(trusted.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: false,
        });
      }),
    ));

  it("remembers a session-wide allow without picking the agent's allow-always", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(harness(log), process.execPath, options());
        const { turn } = yield* collect(session);
        yield* session.send("run");
        yield* turn((request) =>
          session.respondToPermission(request.requestId, { decision: "allow", scope: "session" }),
        );
        yield* session.send("run");
        const second = yield* turn();
        expect(second.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(second.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: false,
        });
      }),
    ));

  it("denies everything but reads in read-only access, on the agent's read-only mode", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(
          harness(log),
          process.execPath,
          options({ access: "readOnly", mcpServers: {} }),
        );
        const { turn } = yield* collect(session);
        expect(requests(log).find((entry) => entry.method === "session/set_mode")?.params.modeId).toBe(
          "read-only",
        );
        yield* session.send("edit");
        const payloads = yield* turn();
        expect(payloads.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(payloads.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: true,
        });
      }),
    ));

  it("interrupts a turn with session/cancel", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(harness(log), process.execPath, options());
        const { turn } = yield* collect(session);
        yield* session.send("wait");
        const fiber = yield* Effect.forkChild(turn());
        yield* Effect.sleep("300 millis");
        yield* session.interrupt;
        const payloads = yield* Fiber.join(fiber);
        expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
        expect(payloads.find((payload) => payload._tag === "MessageCompleted")).toMatchObject({
          text: "Working",
        });
      }),
    ));

  it("compacts with the agent's command and reports the compaction once", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(harness(log), process.execPath, options());
        const { turn } = yield* collect(session);
        yield* session.compact!;
        const payloads = yield* turn();
        expect(payloads.filter((payload) => payload._tag === "ContextCompacted")).toEqual([
          { _tag: "ContextCompacted", trigger: "manual", summary: "Summary." },
        ]);
      }),
    ));

  it("resumes with session/resume and keeps the model asked for", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const session = yield* startAcpSession(
          harness(log),
          process.execPath,
          options({ resume: "old-a", model: "fake-fast" }),
        );
        const { first } = yield* collect(session);
        expect(first).toMatchObject({
          _tag: "SessionStarted",
          providerSessionId: "old-a",
          model: "fake-fast",
        });
        expect(requests(log).find((entry) => entry.method === "session/resume")?.params.sessionId).toBe(
          "old-a",
        );
        // It resumed on fake-smart, so Cerium switched it back.
        expect(
          requests(log).find((entry) => entry.method === "session/set_config_option")?.params.value,
        ).toBe("fake-fast");
        expect(requests(log).some((entry) => entry.method === "session/new")).toBe(false);
      }),
    ));

  it("reports a signed-out agent as HarnessUnavailable", () =>
    run(
      Effect.gen(function* () {
        const error = yield* startAcpSession(
          harness(freshLog(), { FAKE_ACP_SIGNED_OUT: "1" }),
          process.execPath,
          options(),
        ).pipe(Effect.flip);
        expect(error._tag).toBe("HarnessUnavailable");
      }),
    ));
});

describe("sign-in and copies", () => {
  it("signs in with the method the harness picks before opening the session", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const definition: AcpHarness = {
          ...harness(log),
          signIn: () => ({ _tag: "Authenticate", methodId: "login", meta: { headless: true } }),
        };
        yield* startAcpSession(definition, process.execPath, options());
        const methods = requests(log).map((entry) => entry.method);
        expect(methods.indexOf("authenticate")).toBeLessThan(methods.indexOf("session/new"));
        expect(requests(log).find((entry) => entry.method === "authenticate")?.params).toEqual({
          methodId: "login",
          _meta: { headless: true },
        });
      }),
    ));

  it("reads an interactive-only sign-in as signed out", () =>
    run(
      Effect.gen(function* () {
        const definition: AcpHarness = { ...harness(freshLog()), signIn: () => ({ _tag: "SignedOut" }) };
        const error = yield* startAcpSession(definition, process.execPath, options()).pipe(Effect.flip);
        expect(error._tag).toBe("HarnessUnavailable");
      }),
    ));

  it("answers aside on a copy made with session/fork, deleted when it ends", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        yield* Effect.gen(function* () {
          const copy = yield* startAcpSession(harness(log), process.execPath, options({ mcpServers: {} }), {
            purpose: "sideQuestion",
            ephemeral: true,
            forkOf: { sessionId: "fake-7" },
          });
          const { first } = yield* collect(copy);
          expect(first).toMatchObject({ _tag: "SessionStarted" });
          expect((first as { providerSessionId: string }).providerSessionId).toMatch(/^fork-/);
        }).pipe(Effect.scoped);
        expect(requests(log).find((entry) => entry.method === "session/fork")?.params.sessionId).toBe(
          "fake-7",
        );
        expect(requests(log).some((entry) => entry.method === "session/delete")).toBe(true);
      }),
    ));

  it("can't copy part of a session without the harness's own fork", () =>
    run(
      Effect.gen(function* () {
        const error = yield* startAcpSession(harness(freshLog()), process.execPath, options(), {
          forkOf: { sessionId: "fake-7", promptIndex: 1 },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("HarnessFailure");
      }),
    ));
});

describe("inspection and history", () => {
  it("lists models and efforts from a fresh session, then deletes it", () =>
    run(
      Effect.gen(function* () {
        const log = freshLog();
        const inspection = yield* inspectAcpAgent(harness(log), process.execPath);
        expect(inspection.signedIn).toBe(true);
        const models = modelsFromSetup("grok", inspection.setup!);
        expect(models).toEqual([
          {
            provider: "grok",
            id: "fake-fast",
            label: "Fake Fast",
            description: "Quick",
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium",
            isDefault: true,
          },
          {
            provider: "grok",
            id: "fake-smart",
            label: "Fake Smart",
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium",
          },
        ]);
        expect(requests(log).some((entry) => entry.method === "session/delete")).toBe(true);
      }),
    ));

  it("reports signed out when session/new needs authentication", () =>
    run(
      Effect.gen(function* () {
        const inspection = yield* inspectAcpAgent(
          harness(freshLog(), { FAKE_ACP_SIGNED_OUT: "1" }),
          process.execPath,
        );
        expect(inspection.signedIn).toBe(false);
      }),
    ));

  it("lists sessions newest first and reads one from its replay", () =>
    run(
      Effect.gen(function* () {
        const definition = harness(freshLog());
        const connection = yield* openAcpConnection({
          provider: "grok",
          name: "Fake agent",
          command: process.execPath,
          args: definition.command({
            purpose: "history",
            cwd: "/",
            access: "readOnly",
            includeUserMcpServers: false,
            injectedMcpServers: [],
          }).args,
        });
        const sessions = yield* listAcpSessions(definition, connection);
        expect(sessions.map((session) => [session.id, session.title])).toEqual([
          ["old-b", "Fake agent session"],
          ["old-a", "Old A"],
        ]);
        const history = yield* readAcpSession(definition, connection, sessions[1]!, "/work");
        expect(history.turns.map((entry) => entry.prompt)).toEqual(["First question", "Second question"]);
        expect(history.turns[0]!.events.map((event) => event.payload._tag)).toEqual([
          "MessageCompleted",
          "ToolCallStarted",
          "ToolCallCompleted",
        ]);
        expect(history.turns[0]!.events[1]!.payload).toMatchObject({
          toolName: "read",
          input: { path: "/work/a.txt" },
        });
      }),
    ));
});

describe("historyFromUpdates", () => {
  it("is empty without a user message", () => {
    expect(historyFromUpdates({ provider: "grok" }, [])).toEqual({ turns: [] });
  });
});
