import type { AdapterEvent, AgentSession, SessionOptions } from "@cerium/harness";
import { EventPayload } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAntigravitySession } from "../src/session.ts";

// The session against `fake-agy.ts`, which loads Cerium's agent, plugin and hook the way Antigravity
// does and runs the hook before each tool: approvals reach Cerium, access modes answer what they can,
// turns resume the conversation, and the agent and plugin are gone when the session ends.

const fake = join(import.meta.dirname, "fake-agy.ts");

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "cerium-agy-"));
  const bin = join(root, "agy");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(bin, 0o755);
  const geminiHome = join(root, "gemini");
  const log = join(root, "runs.jsonl");
  process.env["FAKE_GEMINI_HOME"] = geminiHome;
  process.env["FAKE_AGY_LOG"] = log;
  const cwd = mkdtempSync(join(tmpdir(), "cerium-agy-work-"));
  writeFileSync(join(cwd, "hello.txt"), "hello");
  return { bin, geminiHome, log, cwd };
};

const options = (cwd: string, overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  cwd,
  model: "gemini-3.8-flash",
  effort: "medium",
  access: "ask",
  mcpServers: {
    cerium: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
  },
  includeUserMcpServers: false,
  trustedMcpServers: ["cerium"],
  appendSystemPrompt: "Follow Cerium.",
  ...overrides,
});

const runs = (log: string): Array<Array<string>> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Array<string>)
    : [];

const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<AdapterEvent>();
    yield* session.events.pipe(
      Stream.runForEach((event) => Queue.offer(seen, event)),
      Effect.ignore,
      Effect.forkScoped,
    );
    const turn = (answer?: (requestId: string) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const payloads: Array<EventPayload> = [];
        while (true) {
          const { payload } = yield* Queue.take(seen);
          expect(Schema.is(EventPayload)(payload)).toBe(true);
          payloads.push(payload);
          if (payload._tag === "PermissionRequested" && answer) yield* answer(payload.requestId);
          if (payload._tag === "TurnCompleted") return payloads;
        }
      });
    return { turn };
  });

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("startAntigravitySession against a scripted agy", () => {
  it("runs each turn on Cerium's agent, starts the session from the first run, and resumes the conversation", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, log, cwd } = setup();
        const session = yield* startAntigravitySession(bin, options(cwd), { geminiHome });
        const { turn } = yield* collect(session);

        // The agent and plugin Cerium wrote.
        const [agentFile] = readdirSync(join(geminiHome, "config", "agents"));
        const agent = readFileSync(join(geminiHome, "config", "agents", agentFile!), "utf8");
        expect(agent).toContain("hidden: true");
        expect(agent).toContain("inheritMcp: false");
        expect(agent).toContain("# Cerium\n\nFollow Cerium.");
        const plugin = /plugins:\n\s+- (.+)\n/.exec(agent)![1]!;
        expect(JSON.parse(readFileSync(join(plugin, "mcp_config.json"), "utf8"))).toEqual({
          mcpServers: {
            cerium: { serverUrl: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
          },
        });

        yield* session.send("hello");
        const first = yield* turn();
        expect(first[0]).toMatchObject({
          _tag: "SessionStarted",
          provider: "antigravity",
          model: "gemini-3.8-flash",
        });
        const sessionId = first[0]!._tag === "SessionStarted" ? first[0]!.providerSessionId : "";
        expect(first.find((payload) => payload._tag === "MessageCompleted")).toMatchObject({
          text: "Hello there",
        });
        expect(first.find((payload) => payload._tag === "UsageReported")).toEqual({
          _tag: "UsageReported",
          inputTokens: 1000,
          outputTokens: 40,
          cachedInputTokens: 200,
        });
        expect(first.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });

        yield* session.setModel("gemini-3.8-pro");
        yield* session.send("hello again");
        const second = yield* turn();
        expect(second.some((payload) => payload._tag === "SessionStarted")).toBe(false);
        const [one, two] = runs(log);
        expect(one).toContain("--agent");
        expect(one).not.toContain("--conversation");
        expect(two).toEqual(
          expect.arrayContaining([
            "--conversation",
            sessionId,
            "--model",
            "gemini-3.8-pro",
            "--effort",
            "medium",
          ]),
        );
      }).pipe(Effect.scoped),
    ));

  it("asks Cerium before a write and honours the answer; a read asks nothing", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, cwd } = setup();
        const session = yield* startAntigravitySession(bin, options(cwd), { geminiHome });
        const { turn } = yield* collect(session);

        yield* session.send("write");
        const allowed = yield* turn((requestId) =>
          session.respondToPermission(requestId, { decision: "allow", scope: "once" }),
        );
        const asked = allowed.find((payload) => payload._tag === "PermissionRequested");
        expect(asked).toMatchObject({
          toolName: "write",
          input: { path: join(cwd, "out.txt"), content: "ok" },
        });
        expect(allowed.find((payload) => payload._tag === "PermissionResolved")).toMatchObject({
          decision: "allow",
        });
        expect(existsSync(join(cwd, "out.txt"))).toBe(true);
        expect(allowed.find((payload) => payload._tag === "FileChanged")).toMatchObject({
          path: join(cwd, "out.txt"),
          change: "created",
        });

        yield* session.send("run");
        const denied = yield* turn((requestId) =>
          session.respondToPermission(requestId, { decision: "deny", scope: "once" }),
        );
        expect(denied.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: true,
        });

        yield* session.send("read");
        const read = yield* turn();
        expect(read.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(read.find((payload) => payload._tag === "ToolCallStarted")).toMatchObject({
          toolName: "read",
          input: { path: join(cwd, "hello.txt") },
        });
      }).pipe(Effect.scoped),
    ));

  it("denies native subagents and, read-only, every write, without asking", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, cwd } = setup();
        const session = yield* startAntigravitySession(bin, options(cwd, { access: "readOnly" }), {
          geminiHome,
        });
        const { turn } = yield* collect(session);
        yield* session.send("subagent");
        const delegated = yield* turn();
        expect(delegated.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(delegated.find((payload) => payload._tag === "ToolCallCompleted")).toMatchObject({
          isError: true,
        });
        yield* session.send("write");
        const wrote = yield* turn();
        expect(wrote.some((payload) => payload._tag === "PermissionRequested")).toBe(false);
        expect(existsSync(join(cwd, "out.txt"))).toBe(false);
      }).pipe(Effect.scoped),
    ));

  it("interrupts a turn with SIGINT", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, cwd } = setup();
        const session = yield* startAntigravitySession(bin, options(cwd), { geminiHome });
        const { turn } = yield* collect(session);
        yield* session.send("slow");
        const fiber = yield* Effect.forkChild(turn());
        yield* Effect.sleep("1 second");
        yield* session.interrupt;
        const payloads = yield* Fiber.join(fiber);
        expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
        expect(payloads.find((payload) => payload._tag === "MessageCompleted")).toMatchObject({
          text: "Counting",
        });
      }).pipe(Effect.scoped),
    ));

  it("reports a plan limit and fails the turn", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, cwd } = setup();
        const session = yield* startAntigravitySession(bin, options(cwd), { geminiHome });
        const { turn } = yield* collect(session);
        yield* session.send("fail");
        const payloads = yield* turn();
        expect(payloads.find((payload) => payload._tag === "LimitReached")).toMatchObject({
          provider: "antigravity",
        });
        expect(payloads.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "error" });
      }).pipe(Effect.scoped),
    ));

  it("removes Cerium's agent and plugin when the session ends", () =>
    run(
      Effect.gen(function* () {
        const { bin, geminiHome, cwd } = setup();
        let plugin = "";
        yield* Effect.gen(function* () {
          yield* startAntigravitySession(bin, options(cwd), { geminiHome });
          const [agentFile] = readdirSync(join(geminiHome, "config", "agents"));
          plugin = /plugins:\n\s+- (.+)\n/.exec(
            readFileSync(join(geminiHome, "config", "agents", agentFile!), "utf8"),
          )![1]!;
          expect(existsSync(plugin)).toBe(true);
        }).pipe(Effect.scoped);
        expect(readdirSync(join(geminiHome, "config", "agents"))).toEqual([]);
        expect(existsSync(plugin)).toBe(false);
      }),
    ));
});
