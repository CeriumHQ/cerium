import { Account } from "@cerium/account";
import { Orchestrator, type CreateThreadInput } from "@cerium/orchestrator";
import type {
  AgentEvent,
  AgentId,
  AgentInfo,
  EventId,
  ThreadId,
  ThreadInfo,
  ThreadNotification,
  ThreadOverview,
} from "@cerium/protocol";
import type { AutomationInput, AutomationView, PushRecord } from "@cerium/rpc";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, FileSystem, Layer, PlatformError, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Automations } from "../src/automations.ts";
import { GitHub } from "../src/github.ts";
import { Notifications } from "../src/notify.ts";
import { Pushes } from "../src/pushes.ts";
import { Reviews } from "../src/reviews.ts";

// Local times, so the tests hold in any time zone. 2026-10-26 is a Monday.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

/** A backend whose orchestrator records the threads it's asked for, and whose pushes the test ends. */
const makeBackend = (github?: Layer.Layer<GitHub>, reviews?: Layer.Layer<Reviews>) =>
  Effect.gen(function* () {
    const root = "/automations-test";
    const project = `${root}/app`;
    const directories = new Set([root, project]);
    const files = new Map<string, string>();
    const missing = (method: string, path: string) =>
      PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path });
    const fileSystem = FileSystem.layerNoop({
      exists: (path) => Effect.succeed(directories.has(path) || files.has(path)),
      makeDirectory: (path) => Effect.sync(() => directories.add(path)),
      writeFileString: (path, data) => Effect.sync(() => files.set(path, data)),
      readFileString: (path) =>
        files.has(path) ? Effect.succeed(files.get(path)!) : Effect.fail(missing("readFileString", path)),
      rename: (oldPath, newPath) =>
        files.has(oldPath)
          ? Effect.sync(() => {
              files.set(newPath, files.get(oldPath)!);
              files.delete(oldPath);
            })
          : Effect.fail(missing("rename", oldPath)),
    });
    const ended = yield* Queue.unbounded<PushRecord>();
    const activity = yield* Queue.unbounded<AgentEvent>();
    const told: Array<ThreadNotification> = [];
    const started: Array<{ input: CreateThreadInput; title?: string; text?: string }> = [];
    const overviews: Array<ThreadOverview> = [];
    const orchestrator = Layer.succeed(Orchestrator, {
      activity: Stream.fromQueue(activity),
      listAgents: (threadId: ThreadId) =>
        Effect.sync(() => overviews.find((each) => each.thread.id === threadId)?.agents ?? []),
      listThreads: Effect.sync(() => overviews.map((each) => each.thread)),
      awaitingApproval: () => false,
      threadOverviews: Effect.sync(() => overviews),
      createThread: (input: CreateThreadInput) =>
        Effect.sync(() => {
          const n = started.push({ input });
          const thread: ThreadInfo = {
            id: `thr_${n}` as ThreadId,
            title: input.title,
            mode: "work",
            cwd: input.cwd!,
            ...(input.workspace?.pullRequestUrl === undefined
              ? {}
              : {
                  worktree: {
                    root: input.cwd!,
                    project: input.cwd!,
                    branch: "cerium/pr-42",
                    base: "main",
                    pullRequestUrl: input.workspace.pullRequestUrl,
                  },
                }),
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
      wake: (agentId: AgentId, text: string) =>
        Effect.sync(() => {
          started[Number(agentId.slice(4)) - 1]!.text = text;
        }),
    } as never);
    const account = Layer.succeed(Account, {
      send: (message: ThreadNotification & { readonly _tag: string }) =>
        Effect.sync(() => {
          if (message._tag === "Notify") told.push(message);
        }),
    } as never);
    const notifications = Notifications.layer.pipe(Layer.provide(Layer.mergeAll(account, orchestrator)));
    const pushes = Layer.succeed(Pushes, { ciEnded: Stream.fromQueue(ended) } as never);
    const context = yield* Layer.build(
      Automations.layer({ file: `${root}/automations.json` }).pipe(
        Layer.provide(
          Layer.mergeAll(
            orchestrator,
            pushes,
            NodeServices.layer,
            fileSystem,
            github ?? Layer.empty,
            notifications,
            reviews ?? Layer.empty,
          ),
        ),
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
    /** Lets the scheduler and the trigger take their turn, `seconds` on, and save to the memory files. */
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
    return { automations, input, started, overviews, ended, wait, views, project, activity, told };
  });
const backend = makeBackend();

const repo = {
  host: "github.com",
  owner: "cerium-fixture",
  name: "app",
  url: "https://github.com/cerium-fixture/app",
  viewer: "octocat",
  defaultBranch: "main",
};

const dated = (id: number, hour: number, minute: number) => ({
  id,
  created_at: new Date(at(26, hour, minute)).toISOString(),
});

const pull = {
  number: 42,
  state: "OPEN",
  title: "Use a different port",
  viewerDidAuthor: true,
  baseRefName: "main",
  baseRefOid: "1".repeat(40),
  headRefName: "change-port",
  headRefOid: "2".repeat(40),
  mergeable: "CONFLICTING",
};

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
      yield* automations.save(view!.automation.id, {
        ...input({ _tag: "CiFailed" }),
        name: "Repair CI",
        prompt: "Fix the failing checks.",
      });
      const run = yield* automations.runNow(view!.automation.id);
      assert.strictEqual(run.detail, "CI failed on main at 9f8e7d6");
      assert.match(started[1]?.text ?? "", /^Fix the failing checks\./);
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

  it.effect("starts issue worktrees for matching new assignments and labels", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const issue = { state: "open", title: "Port selection", body: "Allow configured ports.", number: 17 };
      const github = Layer.succeed(GitHub, {
        repository: () => Effect.succeed(repo),
        rest: (_: string, __: string, endpoint: string) =>
          Effect.succeed(
            endpoint.includes("/issues/events?")
              ? [
                  {
                    ...dated(4, 12, 0),
                    event: "labeled",
                    label: { name: "agent-ready" },
                    issue: { ...issue, pull_request: {} },
                  },
                  { ...dated(3, 12, 0), event: "labeled", label: { name: "agent-ready" }, issue },
                  { ...dated(2, 12, 0), event: "assigned", assignee: { login: "Octocat" }, issue },
                  { ...dated(1, 11, 59), event: "labeled", label: { name: "agent-ready" }, issue },
                ]
              : { ...issue, labels: [{ name: "agent-ready" }], assignees: [{ login: "octocat" }] },
          ),
      } as never);
      const { automations, input, started, wait, views } = yield* makeBackend(github);
      yield* automations.save(
        undefined,
        input({ _tag: "IssueLabeled", label: "agent-ready", action: "draftPr" }),
      );
      yield* automations.save(undefined, input({ _tag: "IssueAssigned", action: "triage" }));
      yield* wait(10);
      assert.lengthOf(started, 2);
      assert.isTrue(started.every((run) => run.input.worktree && run.input.workspace?.baseRef === "main"));
      assert.isTrue(started.some((run) => run.text?.includes("open a draft pull request")));
      assert.isTrue(started.some((run) => run.text?.includes("Keep the triage in Cerium")));
      assert.isTrue(started.every((run) => run.text?.includes(`${repo.url}/issues/17`)));
      yield* wait(65);
      assert.lengthOf(started, 2);
      assert.deepEqual(
        (yield* views).map((view) => view.runs.length),
        [1, 1],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("queues review replies for a busy PR thread and wakes it with the exact discussion", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const issue = { state: "open", number: 42, pull_request: {} };
      const root = {
        ...dated(33, 11, 50),
        path: "src/app.ts",
        line: 17,
        body: "Validate the configured port.",
      };
      const other = { ...dated(34, 11, 51), path: "README.md", body: "Unrelated comment" };
      const reply = {
        ...dated(35, 12, 1),
        in_reply_to_id: 33,
        body: "Please also reject port zero.",
        pull_request_url: "https://api.github.com/repos/cerium-fixture/app/pulls/42",
      };
      let replied = false;
      const github = Layer.succeed(GitHub, {
        repository: () => Effect.succeed(repo),
        graphql: () => Effect.succeed({ repository: { pullRequest: pull } }),
        rest: (_: string, __: string, endpoint: string) =>
          Effect.sync(() => {
            if (endpoint.includes("/issues/events?"))
              return [
                {
                  ...dated(21, 12, 0),
                  event: "review_requested",
                  issue,
                  requested_reviewer: { login: "octocat" },
                },
              ];
            if (endpoint.includes("/pulls/comments?")) return replied ? [reply] : [];
            return replied ? [root, other, reply] : [root, other];
          }),
      } as never);
      const { automations, input, started, overviews, wait, views } = yield* makeBackend(github);
      yield* automations.save(undefined, {
        ...input({ _tag: "PullRequestReview" }),
        reviewOnCompletion: true,
      });
      yield* wait(10);
      assert.lengthOf(started, 1);
      assert.strictEqual(started[0]?.input.workspace?.pullRequestUrl, `${repo.url}/pull/42`);
      assert.strictEqual(started[0]?.input.lead.access, "acceptEdits");
      replied = true;
      yield* wait(65);
      assert.lengthOf((yield* views)[0]?.runs ?? [], 1);
      const overview = overviews[0]!;
      overviews[0] = { ...overview, agents: [{ ...overview.agents[0]!, state: "idle" }] };
      yield* wait(65);
      assert.lengthOf(started, 1);
      assert.lengthOf((yield* views)[0]?.runs ?? [], 2);
      assert.include(started[0]?.text ?? "", "Validate the configured port.");
      assert.include(started[0]?.text ?? "", "Please also reject port zero.");
      assert.notInclude(started[0]?.text ?? "", "Unrelated comment");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("repairs a PR once per conflicting revision pair", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      let headRefOid = pull.headRefOid;
      const github = Layer.succeed(GitHub, {
        repository: () => Effect.succeed(repo),
        graphql: (_: string, query: string) =>
          Effect.sync(() => ({
            repository: query.includes("pullRequests(")
              ? { pullRequests: { nodes: [{ ...pull, headRefOid }] } }
              : { pullRequest: { ...pull, headRefOid } },
          })),
      } as never);
      const { automations, input, started, overviews, wait, views } = yield* makeBackend(github);
      const saved = yield* automations.save(undefined, input({ _tag: "PullRequestConflicts" }));
      yield* wait(10);
      assert.lengthOf(started, 1);
      assert.include(started[0]?.text ?? "", "rerun the relevant project checks");
      const overview = overviews[0]!;
      overviews[0] = { ...overview, agents: [{ ...overview.agents[0]!, state: "idle" }] };
      yield* wait(65);
      assert.lengthOf((yield* views)[0]?.runs ?? [], 1);
      headRefOid = "3".repeat(40);
      yield* wait(65);
      assert.lengthOf(started, 1);
      assert.lengthOf((yield* views)[0]?.runs ?? [], 2);
      assert.include(started[0]?.text ?? "", headRefOid);
      yield* automations.pause(saved.id, true);
      headRefOid = "4".repeat(40);
      yield* wait(65);
      yield* automations.pause(saved.id, false);
      yield* wait(65);
      assert.lengthOf((yield* views)[0]?.runs ?? [], 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("holds the finished notification until automatic review has a result", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(26, 12));
      const letReviewFinish = yield* Deferred.make<void>();
      const reviewed: Array<ThreadId> = [];
      const reviews = Layer.succeed(Reviews, {
        completeAutomation: (threadId: ThreadId) =>
          Effect.gen(function* () {
            reviewed.push(threadId);
            yield* Deferred.await(letReviewFinish);
            return { findings: [{}] };
          }),
      } as never);
      const { automations, input, overviews, wait, told, activity } = yield* makeBackend(undefined, reviews);
      const automation = yield* automations.save(undefined, {
        ...input({ _tag: "Hourly", minute: 0 }),
        reviewOnCompletion: true,
      });
      const run = yield* automations.runNow(automation.id);
      const overview = overviews[0]!;
      const agent = { ...overview.agents[0]!, state: "idle" as const };
      overviews[0] = { ...overview, agents: [agent] };
      yield* Queue.offer(activity, {
        id: "evt_finished" as EventId,
        threadId: overview.thread.id,
        agentId: agent.id,
        sequence: 1,
        at: at(26, 12),
        payload: { _tag: "AgentStateChanged", state: "idle" },
      });
      yield* wait(5);
      assert.deepEqual(reviewed, [run.threadId]);
      assert.lengthOf(told, 0);
      yield* Deferred.succeed(letReviewFinish, undefined);
      yield* wait(1);
      assert.lengthOf(told, 1);
      assert.strictEqual(told[0]?.kind, "finished");
      assert.include(told[0]?.detail ?? "", "Cross-lab review finished with 1 finding.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
