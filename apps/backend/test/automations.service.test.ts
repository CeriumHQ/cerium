import { Orchestrator, type CreateThreadInput } from "@cerium/orchestrator";
import type { AgentId, AgentInfo, ThreadId, ThreadInfo, ThreadOverview } from "@cerium/protocol";
import type { AutomationInput, AutomationView, PushRecord } from "@cerium/rpc";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Automations } from "../src/automations.ts";
import { Pushes } from "../src/pushes.ts";

// Local times, so the tests hold in any time zone. 2026-10-26 is a Monday.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

/** A backend whose orchestrator records the threads it's asked for, and whose pushes the test ends. */
const backend = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const project = `${root}/app`;
  yield* fs.makeDirectory(project);
  const ended = yield* Queue.unbounded<PushRecord>();
  const started: Array<{ input: CreateThreadInput; title?: string; text?: string }> = [];
  const overviews: Array<ThreadOverview> = [];
  const orchestrator = Layer.succeed(Orchestrator, {
    threadOverviews: Effect.sync(() => overviews),
    createThread: (input: CreateThreadInput) =>
      Effect.sync(() => {
        const n = started.push({ input });
        const thread: ThreadInfo = {
          id: `thr_${n}` as ThreadId,
          title: input.title,
          mode: "work",
          cwd: input.cwd!,
          createdAt: 0,
          updatedAt: 0,
        };
        const lead: AgentInfo = {
          id: `agt_${n}` as AgentId,
          threadId: thread.id,
          role: "lead",
          provider: input.lead.provider,
          model: input.lead.model,
          access: input.lead.access,
          state: "running",
          createdAt: 0,
          updatedAt: 0,
        };
        overviews.push({ thread, agents: [lead], awaitingApproval: false });
        return { thread, lead };
      }),
    renameThread: (threadId: ThreadId, title: string) =>
      Effect.sync(() => {
        started[Number(threadId.slice(4)) - 1]!.title = title;
      }),
    sendUserMessage: (agentId: AgentId, text: string) =>
      Effect.sync(() => {
        started[Number(agentId.slice(4)) - 1]!.text = text;
      }),
  } as never);
  const pushes = Layer.succeed(Pushes, { ciEnded: Stream.fromQueue(ended) } as never);
  const context = yield* Layer.build(
    Automations.layer({ file: `${root}/automations.json` }).pipe(
      Layer.provide(Layer.mergeAll(orchestrator, pushes, NodeServices.layer)),
    ),
  );
  const automations = Context.get(context, Automations);
  const input = (when: AutomationInput["when"]): AutomationInput => ({
    name: "Morning triage",
    prompt: "Look at the open issues.",
    project,
    worktree: false,
    lead: { provider: "claude", model: "opus", access: "auto" },
    when,
  });
  /** Lets the scheduler and the trigger take their turn, `seconds` on, and save to the real disk. */
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
  const wait = (seconds: number) =>
    Effect.gen(function* () {
      yield* settle;
      yield* TestClock.adjust(`${seconds} seconds`);
      yield* settle;
    });
  const views = Stream.runHead(automations.watch).pipe(
    Effect.map((head) => (head._tag === "Some" ? head.value : ([] as ReadonlyArray<AutomationView>))),
  );
  return { automations, input, started, overviews, ended, wait, views, project };
});

const failedPush = (project: string, overrides: Partial<PushRecord> = {}): PushRecord => ({
  id: "push-1",
  threadId: "thr_other" as ThreadId,
  agentId: "agt_other" as AgentId,
  cwd: project,
  remote: "origin",
  branch: "main",
  createdAt: 1,
  updatedAt: 2,
  stage: "pushed",
  hook: [],
  output: "",
  commits: [],
  head: "1a2b3c4d5e6f",
  ci: { state: "failed", runs: [], checks: [], failures: [] },
  ...overrides,
});

describe("Automations", () => {
  it.effect("starts a scheduled run at its time, named for when it ran", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 8, 58));
      const { automations, input, started, wait, views } = yield* backend;
      yield* automations.save(undefined, input({ _tag: "Daily", at: 9 * 60 }));
      assert.strictEqual((yield* views)[0]?.nextAt, at(26, 9));
      yield* wait(60);
      assert.strictEqual(started.length, 0);
      yield* wait(80);
      assert.strictEqual(started.length, 1);
      assert.strictEqual(started[0]?.input.title, "Morning triage");
      assert.match(started[0]?.title ?? "", /^Morning triage · Oct 26/);
      assert.strictEqual(started[0]?.text, "Look at the open issues.");
      const [view] = yield* views;
      assert.strictEqual(view?.runs[0]?.cause, "schedule");
      assert.strictEqual(view?.runs[0]?.threadId, "thr_1");
      assert.strictEqual(view?.nextAt, at(27, 9));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits out a run that's still working, and starts nothing while paused", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 9, 59));
      const { automations, input, started, wait, views } = yield* backend;
      const saved = yield* automations.save(undefined, input({ _tag: "Hourly", minute: 0 }));
      yield* wait(90);
      assert.strictEqual(started.length, 1);
      // The first run's lead still works an hour on.
      yield* wait(60 * 60);
      assert.strictEqual(started.length, 1);
      assert.strictEqual((yield* views)[0]?.runs[0]?.skipped, "The last run is still working.");
      yield* automations.pause(saved.id, true);
      yield* wait(60 * 60);
      assert.strictEqual((yield* views)[0]?.runs.length, 2);
      assert.isUndefined((yield* views)[0]?.nextAt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs now, paused or not", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const { automations, input, started } = yield* backend;
      const saved = yield* automations.save(undefined, input({ _tag: "Weekdays", at: 9 * 60 }));
      yield* automations.pause(saved.id, true);
      const run = yield* automations.runNow(saved.id);
      assert.strictEqual(run.cause, "manual");
      assert.strictEqual(run.threadId, "thr_1");
      assert.strictEqual(started.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts a thread when a push's CI fails in its project, once per push", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const { automations, input, started, ended, wait, project, views } = yield* backend;
      yield* automations.save(undefined, { ...input({ _tag: "CiFailed" }), name: "Fix CI" });
      yield* Queue.offer(ended, failedPush(project));
      yield* Queue.offer(ended, failedPush(project));
      yield* Queue.offer(ended, failedPush(`${project}-elsewhere`, { id: "push-2" }));
      yield* Queue.offer(
        ended,
        failedPush(project, { id: "push-3", ci: { state: "passed", runs: [], checks: [], failures: [] } }),
      );
      yield* wait(1);
      assert.strictEqual(started.length, 1);
      assert.strictEqual(started[0]?.title, "Fix CI · main 1a2b3c4");
      assert.match(
        started[0]?.text ?? "",
        /^Look at the open issues\.\n\n---\n\nCI failed on main at 1a2b3c4/,
      );
      assert.strictEqual((yield* views)[0]?.runs[0]?.detail, "CI failed on main at 1a2b3c4");
      // A push from the thread the automation started is that thread's to fix.
      yield* Queue.offer(ended, failedPush(project, { id: "push-4", threadId: "thr_1" as ThreadId }));
      yield* wait(1);
      assert.strictEqual(started.length, 1);
      // Paused, a failure starts nothing, and Run now replays it.
      const [view] = yield* views;
      yield* automations.pause(view!.automation.id, true);
      yield* Queue.offer(ended, failedPush(project, { id: "push-5", head: "9f8e7d6c5b4a" }));
      yield* wait(1);
      assert.strictEqual(started.length, 1);
      const run = yield* automations.runNow(view!.automation.id);
      assert.strictEqual(run.detail, "CI failed on main at 9f8e7d6");
      assert.match(started[1]?.text ?? "", /CI failed on main at 9f8e7d6/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a run whose project folder is gone, saying so", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const { automations, input, started } = yield* backend;
      const saved = yield* automations.save(undefined, {
        ...input({ _tag: "CiFailed" }),
        project: "Z:/nowhere",
      });
      const run = yield* automations.runNow(saved.id);
      assert.strictEqual(started.length, 0);
      assert.match(run.failed ?? "", /isn't there/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
