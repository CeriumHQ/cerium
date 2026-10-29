import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, InputItem, ThreadId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, PubSub, Stream } from "effect";

import {
  Orchestrator,
  ProjectScripts,
  type ResolvedScripts,
  type ScriptEnded,
  type ScriptServed,
  type ScriptStatus,
  ScriptsError,
} from "../src/index.ts";
import { runAnswer, runLines } from "../src/projectRun.ts";
import { systemPrompt } from "../src/prompts.ts";
import { recordEvents, testLayer } from "./fakes.ts";

// The project_run tool's side of the orchestrator, over scripts that are a puppet: what the project
// offers, how its run stands, and what it is told are the test's.

const inputsOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId): ReadonlyArray<InputItem> =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? event.payload.items : [],
  );

/** Scripts that record what they are asked and answer from `state`. */
const puppetScripts = (commands: ResolvedScripts) => {
  const state: { status: ScriptStatus | undefined; calls: Array<string> } = { status: undefined, calls: [] };
  const ended = Effect.runSync(PubSub.unbounded<ScriptEnded>());
  const served = Effect.runSync(PubSub.unbounded<ScriptServed>());
  const layer = Layer.succeed(
    ProjectScripts,
    ProjectScripts.of({
      resolve: () => Effect.succeed(commands),
      start: ({ kind }) =>
        Effect.sync(() => {
          state.calls.push(`start ${kind}`);
          state.status = { running: true, url: "http://localhost:5173/", output: "VITE ready" };
          const command = commands[kind];
          return command === undefined
            ? undefined
            : ({ _tag: "Ran", script: command.text, from: command.from } as const);
        }),
      stop: (_threadId, kind) =>
        Effect.sync(() => {
          state.calls.push(`stop ${kind}`);
          const had = state.status !== undefined;
          state.status = undefined;
          return had;
        }),
      status: (_threadId, kind) =>
        Effect.sync(() => {
          state.calls.push(`status ${kind}`);
          return state.status;
        }),
      startAction: () => Effect.fail(new ScriptsError({ message: "No actions here." })),
      writeFile: () => Effect.void,
      ended: Stream.fromPubSub(ended),
      served: Stream.fromPubSub(served),
      teardown: () => Effect.succeed(undefined),
      ports: () => Effect.succeed(undefined),
    }),
  );
  return { state, ended, served, layer };
};

const confirmed: ResolvedScripts = {
  setup: { text: "bun install", from: "project" },
  run: { text: "bun run dev", from: "saved" },
};

const startThread = (access: "auto" | "readOnly" = "auto") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    return yield* orchestrator.createThread({
      title: "Test",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access },
    });
  });

describe("Orchestrator.projectRun", () => {
  it.live("reads how the run stands: stopped before it starts, then running with its address", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread();
      const before = yield* orchestrator.projectRun(lead.id, { action: "status" });
      assert.deepStrictEqual(before, {
        script: "run",
        command: "bun run dev",
        state: "stopped",
        output: "",
        note: "Not running: nothing started it in this thread, or it was stopped.",
      });

      puppet.state.status = { running: true, url: "http://localhost:3000/", output: "ready" };
      const running = yield* orchestrator.projectRun(lead.id, { action: "status", lines: 5 });
      assert.strictEqual(running.state, "running");
      assert.strictEqual(running.url, "http://localhost:3000/");
      assert.strictEqual(running.output, "ready");
      assert.include(running.note, "browser_open");

      puppet.state.status = { running: false, exitCode: 2, output: "boom" };
      const failed = yield* orchestrator.projectRun(lead.id, { action: "status" });
      assert.deepStrictEqual([failed.state, failed.exitCode], ["exited", 2]);
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("starts the run once, restarts it on request, and stops it", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread();
      const started = yield* orchestrator.projectRun(lead.id, { action: "start" });
      assert.deepStrictEqual(
        [started.state, started.url, started.command],
        ["running", "http://localhost:5173/", "bun run dev"],
      );

      const again = yield* orchestrator.projectRun(lead.id, { action: "start" });
      assert.strictEqual(again.state, "running");
      assert.include(again.note, "wasn't started again");
      assert.include(again.note, "Serving at http://localhost:5173/");
      const restarted = yield* orchestrator.projectRun(lead.id, { action: "restart" });
      assert.strictEqual(restarted.state, "running");
      const stopped = yield* orchestrator.projectRun(lead.id, { action: "stop" });
      assert.deepStrictEqual([stopped.state, stopped.note], ["stopped", "Stopped."]);
      const idle = yield* orchestrator.projectRun(lead.id, { action: "stop" });
      assert.strictEqual(idle.note, "It wasn't running.");

      assert.deepStrictEqual(
        puppet.state.calls.filter((call) => !call.startsWith("status")),
        ["start run", "start run", "stop run", "stop run"],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("runs the setup when asked, and refuses what the project hasn't confirmed", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts({ setup: { text: "bun install", from: "guessed" } });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread();
      const guessed = yield* Effect.flip(
        orchestrator.projectRun(lead.id, { action: "start", script: "setup" }),
      );
      assert.strictEqual(guessed.reason, "notAllowed");
      assert.include(guessed.message, "`bun install`");
      const none = yield* Effect.flip(orchestrator.projectRun(lead.id, { action: "start" }));
      assert.strictEqual(none.reason, "invalid");
      assert.include(none.message, "No run command");
      assert.deepStrictEqual(puppet.state.calls, []);
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("asks like a command does: a read-only agent is denied, and nothing starts", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread("readOnly");
      for (const action of ["start", "restart", "stop"] as const) {
        const denied = yield* orchestrator.projectRun(lead.id, { action });
        assert.strictEqual(denied.state, "denied");
        assert.include(denied.note, "read-only");
      }
      assert.deepStrictEqual(
        puppet.state.calls.filter((call) => !call.startsWith("status")),
        [],
      );
      // Reading needs no say-so.
      assert.strictEqual((yield* orchestrator.projectRun(lead.id, { action: "status" })).state, "stopped");
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("serves a child of the thread, and no agent that isn't running", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread();
      const spawned = yield* orchestrator.spawn(lead.id, { role: "tester", model: "opus", prompt: "test" });
      const childId = spawned._tag === "Spawned" ? spawned.agentId : ("" as AgentId);
      assert.strictEqual((yield* orchestrator.projectRun(childId, { action: "start" })).state, "running");
      const missing = yield* Effect.flip(
        orchestrator.projectRun("agt_none" as AgentId, { action: "status" }),
      );
      assert.strictEqual(missing.reason, "notFound");
    }).pipe(
      Effect.provide(
        testLayer([fake.adapter], {
          scripts: puppet.layer,
          catalog: [{ alias: "opus", provider: "claude", model: "opus", description: "Everything" }],
        }),
      ),
      Effect.scoped,
    );
  });

  it.live("says what went wrong when scripts can't be resolved", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startThread();
      const error = yield* Effect.flip(orchestrator.projectRun(lead.id, { action: "status" }));
      assert.strictEqual(error.reason, "invalid");
      assert.strictEqual(error.message, "Scripts aren't available here.");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});

describe("Orchestrator script notices", () => {
  const noticeTexts = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
    inputsOf(events, agentId).flatMap((item) => (item._tag === "SystemNotice" ? [item.text] : []));
  const turnsOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
    events.filter((event) => event.agentId === agentId && event.payload._tag === "TurnInput").length;

  const address = (threadId: ThreadId): ScriptServed => ({
    threadId,
    kind: "run",
    script: "bun run dev",
    url: "http://localhost:5173/",
  });

  it.live("holds the run's news for an idle lead's next turn, the latest replacing the earlier", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startThread();
      yield* Effect.sleep(Duration.millis(30));
      const threadId = thread.id as ThreadId;

      PubSub.publishUnsafe(puppet.served, address(threadId));
      yield* Effect.sleep(Duration.millis(100));
      assert.strictEqual(turnsOf(seen, lead.id), 0, "a run that serves wakes nobody");

      PubSub.publishUnsafe(puppet.ended, { threadId, kind: "run", script: "bun run dev", code: 3 });
      yield* Effect.sleep(Duration.millis(100));
      assert.strictEqual(turnsOf(seen, lead.id), 0, "nor does one that fails");

      yield* orchestrator.sendUserMessage(lead.id, "carry on");
      yield* waitFor((events) => (turnsOf(events, lead.id) > 0 ? true : undefined));
      const heard = noticeTexts(seen, lead.id);
      assert.strictEqual(heard.length, 1, "what the failure says replaces what the serving said");
      assert.include(heard[0], "exit code 3");
      assert.include(heard[0], "its terminal shows why");
      assert.deepStrictEqual(
        inputsOf(seen, lead.id).map((item) => item._tag),
        ["SystemNotice", "FromUser"],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("tells an idle lead at once when its setup ends, with why it failed", () => {
    const fake = makeFakeAdapter("claude");
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startThread();
      yield* Effect.sleep(Duration.millis(30));
      const threadId = thread.id as ThreadId;

      PubSub.publishUnsafe(puppet.ended, {
        threadId,
        kind: "setup",
        script: "bun install",
        code: 1,
        output: "error: 404 not found",
      });
      yield* waitFor((events) => (noticeTexts(events, lead.id).length > 0 ? true : undefined));
      const [failed] = noticeTexts(seen, lead.id);
      assert.include(failed, "setup");
      assert.include(failed, "exit code 1");
      assert.include(failed, "error: 404 not found");
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });

  it.live("tells a lead that is mid-turn as any notice, where the run serves", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: Duration.millis(300) });
    const puppet = puppetScripts(confirmed);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startThread();
      const threadId = thread.id as ThreadId;
      yield* orchestrator.sendUserMessage(lead.id, "build it");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.agentId === lead.id &&
            event.payload._tag === "AgentStateChanged" &&
            event.payload.state === "running",
        ),
      );

      PubSub.publishUnsafe(puppet.served, address(threadId));
      yield* waitFor((events) => (noticeTexts(events, lead.id).length > 0 ? true : undefined));
      const [serving] = noticeTexts(seen, lead.id);
      assert.include(serving, "serving at http://localhost:5173/");
      assert.include(serving, "browser_open");
    }).pipe(Effect.provide(testLayer([fake.adapter], { scripts: puppet.layer })), Effect.scoped);
  });
});

describe("runAnswer", () => {
  it("bounds the lines asked for", () => {
    assert.strictEqual(runLines(undefined), 40);
    assert.strictEqual(runLines(0), 1);
    assert.strictEqual(runLines(12.7), 12);
    assert.strictEqual(runLines(9_000), 200);
  });

  it("reads each way a script can stand", () => {
    const running = runAnswer("run", { running: true, output: "x" });
    assert.include(running.note, "hasn't printed a local address");
    assert.include(runAnswer("setup", { running: true, output: "" }).note, "lead is told when it ends");
    assert.strictEqual(runAnswer("setup", { running: false, exitCode: 0, output: "" }).note, "Finished.");
    assert.include(runAnswer("run", { running: false, exitCode: 9, output: "" }).note, "exit code 9");
    assert.strictEqual(runAnswer("run", undefined, { note: "Stopped." }).note, "Stopped.");
  });
});

describe("the lead's instructions", () => {
  it("point the lead at project_run, which a child finds in the bus's own description", () => {
    const agent = {
      id: "agt_1" as AgentId,
      threadId: "thr_1" as ThreadId,
      role: "lead",
      provider: "claude",
      model: "opus",
      access: "ask",
      state: "idle",
      createdAt: 0,
      updatedAt: 0,
    } as const;
    assert.include(systemPrompt(agent as never, "cerium"), "`project_run` tool (`cerium` MCP server)");
    assert.notInclude(systemPrompt({ ...agent, parentId: "agt_0" } as never, "cerium"), "project_run");
  });
});
