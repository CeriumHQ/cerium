// Stages the threads the website's pictures show, so they are taken of the real app and can be taken
// again whenever its interface changes: a data folder holding a small project and a few finished
// threads, written straight into the store with no agent run.
//
//   node apps/site/scripts/stage.ts <dir>
//   node apps/backend/src/main.ts --data-dir=<dir> --connection-file=<dir>/connection.json
//   node apps/site/scripts/shoot.ts <dir>
//
// The folder is made new each time; `shoot.ts` drives the app over it and writes the site's media.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  AccessMode,
  AgentEvent,
  AgentId,
  AgentInfo,
  EventId,
  EventPayload,
  ProviderId,
  ThreadId,
  ThreadInfo,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Effect } from "effect";

const [target] = process.argv.slice(2);
if (target === undefined) {
  console.error("stage needs the folder to stage into.");
  process.exit(1);
}
const dir = resolve(target);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// The moment the staged work ended: yesterday afternoon, so nothing the backend reads lies ahead of
// it. `shoot.ts` sets the app's clock to it, and "now" and "1h" read the same whenever it runs.
const ended = new Date();
ended.setDate(ended.getDate() - 1);
ended.setHours(16, 20, 0, 0);
const now = ended.getTime();
const minutes = (count: number) => count * 60_000;

// ── The project the threads work in: a small job queue, as a repository with one commit. ──

const queueTs = `export interface AddOptions {
  readonly signal?: AbortSignal;
  readonly priority?: number;
}

export class Queue {
  readonly #concurrency: number;
  readonly #pending = new Set<Job>();
  #running = 0;

  constructor(options: { concurrency?: number } = {}) {
    this.#concurrency = options.concurrency ?? Infinity;
  }

  add<T>(run: () => Promise<T>, options: AddOptions = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const job = { run, resolve, reject, priority: options.priority ?? 0 };
      this.#pending.add(job);
      this.#drain();
    });
  }
}
`;

const project = (name: string, files: Readonly<Record<string, string>>) => {
  const folder = join(dir, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const git = (...args: ReadonlyArray<string>) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("add", ".");
  git("-c", "user.name=Cerium", "-c", "user.email=cerium@example.com", "commit", "-m", "Initial commit");
  return folder;
};

const tinyqueue = project("tinyqueue", {
  "package.json": `${JSON.stringify({ name: "tinyqueue", version: "0.4.0", type: "module" }, null, 2)}\n`,
  "README.md": "# tinyqueue\n\nA small promise queue with priorities, retries and cancellation.\n",
  "src/queue.ts": queueTs,
  "test/queue.test.ts": 'import { test } from "bun:test";\n\ntest.todo("drains in priority order");\n',
});
const linkpad = project("linkpad", {
  "package.json": `${JSON.stringify({ name: "linkpad", version: "1.2.0", type: "module" }, null, 2)}\n`,
  "src/shorten.ts": "export const shorten = (url: string) => url;\n",
});

// ── Threads, their agents and what each did. ──

interface Staged {
  readonly thread: ThreadInfo;
  readonly agents: Array<AgentInfo>;
  readonly events: Array<AgentEvent>;
}

const staged: Array<Staged> = [];

/** A thread that ended `ago` minutes back, and what writes its agents' histories. */
const thread = (title: string, cwd: string, ago: number, started = ago + 5) => {
  const id = `thr_${staged.length + 1}` as ThreadId;
  const entry: Staged = {
    thread: {
      id,
      title,
      mode: "work",
      cwd,
      createdAt: now - minutes(started),
      updatedAt: now - minutes(ago),
    },
    agents: [],
    events: [],
  };
  staged.push(entry);
  const agent = (
    role: string,
    provider: ProviderId,
    model: string,
    access: AccessMode,
    parentId?: AgentId,
    startedAgo = started,
  ) => {
    const agentId = `agt_${staged.length}_${entry.agents.length + 1}` as AgentId;
    entry.agents.push({
      id: agentId,
      threadId: id,
      ...(parentId === undefined ? {} : { parentId }),
      role,
      provider,
      model,
      ...(parentId === undefined ? { effort: "high" as const } : {}),
      access,
      state: "idle",
      createdAt: now - minutes(startedAgo),
      updatedAt: now - minutes(ago),
    });
    let sequence = 0;
    let clock = now - minutes(startedAgo);
    /** An event `after` milliseconds after this agent's last. */
    const event = (payload: EventPayload, after = 1_500) => {
      sequence++;
      clock += after;
      entry.events.push({
        id: `${agentId}:${sequence}` as EventId,
        threadId: id,
        agentId,
        sequence,
        at: clock,
        payload,
      });
    };
    /** A tool call that `took` milliseconds. */
    const tool = (toolName: string, input: unknown, output: unknown, took = 900) => {
      const callId = `${agentId}:c${sequence}`;
      event({ _tag: "ToolCallStarted", callId, toolName, input });
      event({ _tag: "ToolCallCompleted", callId, output, isError: false }, took);
    };
    event({ _tag: "SessionStarted", provider, providerSessionId: `s_${agentId}`, model }, 0);
    return { id: agentId, event, tool };
  };
  return { id, agent };
};

/** A thread with one finished exchange, for the sidebar's list. */
const settled = (
  title: string,
  cwd: string,
  ago: number,
  lead: readonly [ProviderId, string],
  asked: string,
  answered: string,
  helpers: ReadonlyArray<readonly [string, ProviderId, string]> = [],
  changed: ReadonlyArray<readonly [path: string, added: number, removed: number]> = [],
) => {
  const { id, agent } = thread(title, cwd, ago);
  const main = agent("lead", lead[0], lead[1], "auto");
  main.event({ _tag: "TurnInput", turnId: TURN, items: [{ _tag: "FromUser", text: asked }] });
  for (const [role, provider, model] of helpers) {
    const child = agent(role, provider, model, "acceptEdits", main.id);
    main.event({ _tag: "AgentSpawned", childId: child.id, role, provider, model, access: "acceptEdits" });
    child.event({ _tag: "TurnInput", items: [{ _tag: "FromUser", text: asked }] });
    child.event({ _tag: "MessageCompleted", messageId: "m1", text: "Done." });
    child.event({ _tag: "TurnCompleted", stopReason: "completed" });
  }
  main.event({ _tag: "MessageCompleted", messageId: "m1", text: answered }, 40_000);
  const [first, ...rest] = changed.map(([path, added, removed]) => ({
    path,
    change: removed === 0 && added > 20 ? ("added" as const) : ("modified" as const),
    added,
    removed,
    via: "edit" as const,
  }));
  main.event({ _tag: "TurnCompleted", stopReason: "completed" });
  // A turn's files are recorded behind it.
  if (first !== undefined) {
    main.event({ _tag: "TurnFilesChanged", turnId: TURN, ...SNAPSHOTS, files: [first, ...rest] });
  }
  return id;
};

// The lead's id is one the app names itself; the helpers' harnesses list their models only while
// signed in, so those are stored by the names they would show.
const OPUS = ["claude", "claude-opus-5-5"] as const;
/** The one turn a settled thread has, and the snapshots its changed files lie between. */
const TURN = "turn1";
const SNAPSHOTS = { before: "snap1", after: "snap2" };
const LUNA = ["codex", "GPT-6 Luna"] as const;
const PICKLE = ["opencode", "Big Pickle"] as const;
const SOL = ["cursor", "GPT-5.6 Sol"] as const;

settled(
  "Fix shorten() id collisions",
  linkpad,
  60 * 26,
  LUNA,
  "Two long URLs can shorten to the same id. Find out how and fix it.",
  "Fixed. The id came from the first six characters of the hash; it now retries with a longer prefix on a collision.",
);
settled(
  "Add queue retries with backoff",
  tinyqueue,
  60 * 25,
  OPUS,
  "Add retries with exponential backoff.",
  "Added `retries` and `backoff` to `queue.add()`, with tests.",
  [["tests", ...LUNA]],
);
settled(
  "Add job priorities",
  tinyqueue,
  60 * 24,
  OPUS,
  "Let a job jump the queue with a priority.",
  "Jobs now drain in priority order, ties in the order they were added.",
  [
    ["tests", ...LUNA],
    ["review", ...SOL],
  ],
);
settled(
  "Show the test suite's results",
  tinyqueue,
  60 * 23,
  PICKLE,
  "Run the suite and show me what's slow.",
  "All 32 tests pass in 1.4s. The three slowest are the backoff tests, which wait on real timers.",
);
settled(
  "Add a timeout option to onIdle",
  tinyqueue,
  95,
  SOL,
  "onIdle() should take a timeout.",
  "`onIdle({ timeout })` rejects with a `TimeoutError` once the time is up.",
);
const reviewed = settled(
  "Add AbortSignal cancellation",
  tinyqueue,
  70,
  OPUS,
  "Let a caller cancel a queued job with an AbortSignal.",
  "A job whose signal aborts now leaves the queue and rejects with the signal's reason. A job that already started keeps running, and its own code decides what the signal means.",
  [
    ["tests", ...LUNA],
    ["docs", ...PICKLE],
  ],
  [
    ["src/queue.ts", 30, 2],
    ["test/abort.test.ts", 64, 0],
    ["README.md", 18, 0],
  ],
);
const repaired = settled(
  "Fix failing CI on main",
  tinyqueue,
  180,
  OPUS,
  "CI failed on main at 9d1e07a. Read the failed logs, fix the break and push again.",
  "The backoff test waited on a real timer and timed out on the runner. It uses fake timers now, and all 37 checks pass on 2c41f9e.",
  [],
  [["test/backoff.test.ts", 9, 6]],
);

// The thread the site shows: a lead hands three jobs to three other harnesses and reports.
{
  const { id: threadId, agent } = thread("Add rate limiting to jobs", tinyqueue, 0, 5);
  const lead = agent("lead", ...OPUS, "auto");
  const plan = (done: number) =>
    lead.event({
      _tag: "TodosUpdated",
      items: [
        "Add the option and its limiter",
        "Hand out tests, docs and a review",
        "Fix what the review finds",
      ].map((text, index) => ({
        text,
        status:
          index < done
            ? ("completed" as const)
            : index === done
              ? ("inProgress" as const)
              : ("pending" as const),
      })),
    });

  lead.event({
    _tag: "TurnInput",
    turnId: "turn1",
    items: [
      {
        _tag: "FromUser",
        text: "Add a `rateLimit` option to `queue.add()`. Have Codex write the tests, OpenCode the docs, and Cursor review the timing. Build it yourself.",
      },
    ],
  });
  plan(0);
  lead.tool("Read", { file_path: "src/queue.ts" }, queueTs);
  lead.tool("Grep", { pattern: "#drain", path: "src" }, "src/queue.ts:21\nsrc/queue.ts:44");
  lead.tool("Read", { file_path: "test/queue.test.ts" }, "…");
  lead.tool("Read", { file_path: "README.md" }, "…");
  lead.tool(
    "Edit",
    {
      file_path: "src/queue.ts",
      old_string: "  readonly priority?: number;\n}",
      new_string:
        "  readonly priority?: number;\n  /** At most `count` jobs start in any `interval` milliseconds. */\n  readonly rateLimit?: { readonly count: number; readonly interval: number };\n}",
    },
    "The file has been updated.",
  );
  lead.event({ _tag: "FileChanged", path: "src/queue.ts", change: "modified" });
  lead.tool("Bash", { command: "bun test", description: "Run the suite" }, " 32 pass\n 0 fail", 6_400);
  plan(1);

  const helpers = (
    [
      [
        "tests",
        ...LUNA,
        "acceptEdits",
        "Write tests for the new rateLimit option in test/ratelimit.test.ts.",
      ],
      ["docs", ...PICKLE, "acceptEdits", "Document the rateLimit option in README.md."],
      [
        "timing-review",
        ...SOL,
        "readOnly",
        "Review the window arithmetic of rateLimit in src/queue.ts. Change nothing.",
      ],
    ] as const
  ).map(([role, provider, model, access, prompt]) => {
    const child = agent(role, provider, model, access, lead.id, 4);
    lead.tool(
      "mcp__cerium__spawn_agent",
      { role, model: role, prompt },
      { status: "spawned", agentId: child.id },
    );
    lead.event({ _tag: "AgentSpawned", childId: child.id, role, provider, model, access });
    child.event({
      _tag: "TurnInput",
      items: [{ _tag: "FromAgent", agentId: lead.id, threadId, text: prompt }],
    });
    return child;
  });
  const [tests, docs, review] = helpers as [(typeof helpers)[0], (typeof helpers)[0], (typeof helpers)[0]];

  const told = {
    tests: "Wrote `test/ratelimit.test.ts` with 12 tests. All pass.",
    docs: "Added a rate limiting section to `README.md`, with an example.",
    review:
      "Two bugs in the window arithmetic:\n\n1. A job that starts exactly on the window's edge counts in both windows.\n2. The timer for the next slot is never cleared when the queue empties.\n\nI changed nothing.",
  };
  tests.tool("Read", { file_path: "src/queue.ts" }, "…");
  tests.tool("Write", { file_path: "test/ratelimit.test.ts", content: "…" }, "The file has been written.");
  tests.event({ _tag: "FileChanged", path: "test/ratelimit.test.ts", change: "created" });
  tests.tool("Bash", { command: "bun test test/ratelimit.test.ts" }, " 12 pass\n 0 fail", 5_200);
  tests.event({ _tag: "MessageCompleted", messageId: "m1", text: told.tests });
  tests.event({ _tag: "UsageReported", inputTokens: 148_000, outputTokens: 6_200 });
  tests.event({ _tag: "ContextReported", tokens: 38_000, window: 400_000 });
  tests.event({ _tag: "TurnCompleted", stopReason: "completed" });

  docs.tool("Read", { file_path: "README.md" }, "…");
  docs.tool(
    "Edit",
    { file_path: "README.md", old_string: "…", new_string: "…" },
    "The file has been updated.",
  );
  docs.event({ _tag: "FileChanged", path: "README.md", change: "modified" });
  docs.event({ _tag: "MessageCompleted", messageId: "m1", text: told.docs });
  docs.event({ _tag: "UsageReported", inputTokens: 61_000, outputTokens: 2_100 });
  docs.event({ _tag: "ContextReported", tokens: 21_000, window: 200_000 });
  docs.event({ _tag: "TurnCompleted", stopReason: "completed" });

  review.tool("Read", { file_path: "src/queue.ts" }, "…");
  review.tool(
    "Grep",
    { pattern: "interval", path: "src" },
    "src/queue.ts:9\nsrc/queue.ts:52\nsrc/queue.ts:58",
  );
  review.event({ _tag: "MessageCompleted", messageId: "m1", text: told.review }, 38_000);
  review.event({ _tag: "UsageReported", inputTokens: 92_000, outputTokens: 3_400 });
  review.event({ _tag: "ContextReported", tokens: 44_000, window: 272_000 });
  review.event({ _tag: "TurnCompleted", stopReason: "completed" });

  lead.event({ _tag: "UsageReported", inputTokens: 212_000, outputTokens: 8_400, costUsd: 0.38 });
  lead.event({ _tag: "TurnCompleted", stopReason: "completed" });

  lead.event(
    {
      _tag: "TurnInput",
      turnId: "turn2",
      items: [
        { _tag: "ChildFinishedTurn", agentId: docs.id, role: "docs", text: told.docs },
        { _tag: "ChildFinishedTurn", agentId: tests.id, role: "tests", text: told.tests },
        { _tag: "ChildFinishedTurn", agentId: review.id, role: "timing-review", text: told.review },
      ],
    },
    95_000,
  );
  plan(2);
  lead.tool(
    "Edit",
    {
      file_path: "src/queue.ts",
      old_string: "    if (started <= edge) {",
      new_string: "    if (started < edge) {",
    },
    "The file has been updated.",
  );
  lead.tool(
    "Edit",
    {
      file_path: "src/queue.ts",
      old_string: "    this.#running--;",
      new_string: "    this.#running--;\n    if (this.#pending.size === 0) clearTimeout(this.#slot);",
    },
    "The file has been updated.",
  );
  lead.event({ _tag: "FileChanged", path: "src/queue.ts", change: "modified" });
  lead.tool("Bash", { command: "bun test", description: "Run the suite" }, " 44 pass\n 0 fail", 7_800);
  plan(3);
  lead.event(
    {
      _tag: "MessageCompleted",
      messageId: "m2",
      text: [
        "Done. `queue.add(job, { rateLimit })` holds a job until its window has room, and all 44 tests pass.",
        "",
        "| Who | Task | What happened |",
        "| --- | --- | --- |",
        "| **Me** (Opus 5.5) | Build | Added the option to `src/queue.ts`, then fixed both bugs the review found. |",
        "| **Codex** (GPT-6 Luna) | Tests | Wrote `test/ratelimit.test.ts` with 12 tests. All pass. |",
        "| **OpenCode** (Big Pickle) | Docs | Added a rate limiting section to `README.md`. |",
        "| **Cursor** (GPT-5.6 Sol) | Review | Edited nothing. Found 2 real bugs in the window arithmetic. |",
      ].join("\n"),
    },
    96_000,
  );
  lead.event({ _tag: "UsageReported", inputTokens: 1_288_000, outputTokens: 11_600, costUsd: 0.73 });
  lead.event({ _tag: "ContextReported", tokens: 212_000, window: 1_000_000 });
  lead.event({ _tag: "TurnCompleted", stopReason: "completed" });
}

// ── What the backend keeps beside the store: a review of one turn, and the automations. ──

const reviewAt = now - minutes(68);
writeFileSync(
  join(dir, "reviews.json"),
  JSON.stringify({
    reviews: [
      {
        id: "rev_1",
        threadId: reviewed,
        target: {
          _tag: "Turn",
          root: tinyqueue,
          turnId: TURN,
          ...SNAPSHOTS,
          paths: ["src/queue.ts", "test/abort.test.ts", "README.md"],
        },
        label: "3 files from this turn",
        files: ["src/queue.ts", "test/abort.test.ts", "README.md"],
        reviewer: { provider: "codex", model: LUNA[1], effort: "high" },
        createdAt: reviewAt,
        updatedAt: reviewAt + 50_000,
        state: "done",
        summary: "The cancellation path is right. Two things to fix before this ships.",
        findings: [
          {
            id: "f1",
            path: "src/queue.ts",
            start: 42,
            end: 42,
            side: "new",
            severity: "medium",
            title: "The abort listener outlives the job",
            body: "The listener stays attached after the job settles, so a signal shared by many jobs keeps every one of them alive. Remove it in `finally`.",
            lines: [
              {
                marker: "+",
                text: '    signal?.addEventListener("abort", onAbort, { once: true });',
                number: 42,
              },
            ],
            state: "open",
          },
          {
            id: "f2",
            path: "src/queue.ts",
            start: 37,
            end: 38,
            side: "new",
            severity: "low",
            title: "An aborted signal still takes a slot",
            body: "A job added with a signal that has already aborted is counted as pending until the next drain. Reject before adding it.",
            lines: [
              { marker: "+", text: "    this.#pending.add(job);", number: 37 },
              { marker: "+", text: "    if (signal?.aborted) return reject(signal.reason);", number: 38 },
            ],
            state: "open",
          },
        ],
      },
    ],
  }),
);

const automation = (
  name: string,
  prompt: string,
  when: object,
  paused: boolean,
  runs: ReadonlyArray<object> = [],
) => ({
  automation: {
    id: `aut_${name.replaceAll(" ", "_").toLowerCase()}`,
    name,
    prompt,
    project: tinyqueue,
    worktree: true,
    lead: { provider: "claude", model: OPUS[1], effort: "high", access: "auto" },
    when,
    reviewOnCompletion: true,
    paused,
    createdAt: now - minutes(60 * 24 * 9),
    updatedAt: now - minutes(60 * 24 * 2),
  },
  runs,
});
// Only the CI trigger is left running: it waits on pushes Cerium made, of which there are none. A
// schedule would start a thread, and with it an agent, while the pictures are taken.
writeFileSync(
  join(dir, "automations.json"),
  JSON.stringify({
    automations: [
      automation(
        "Fix failing CI",
        "CI failed. Read the failed logs, fix the break and push again.",
        { _tag: "CiFailed" },
        false,
        [
          {
            id: "run_1",
            at: now - minutes(185),
            cause: "trigger",
            detail: "CI failed on main at 9d1e07a",
            threadId: repaired,
          },
        ],
      ),
      automation(
        "Morning dependency check",
        "Check for outdated dependencies and open a pull request for the safe updates.",
        { _tag: "Weekdays", at: 9 * 60 },
        true,
      ),
      automation(
        "Triage new issues",
        "Read the issue, reproduce it if you can, and label it.",
        { _tag: "IssueLabeled", label: "needs-triage", action: "triage" },
        true,
      ),
    ],
  }),
);

await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.saveProject(linkpad, now - minutes(60 * 26));
    yield* store.saveProject(tinyqueue, now);
    for (const { thread, agents, events } of staged) {
      yield* store.createThread(thread);
      for (const agent of agents) yield* store.createAgent(agent);
      yield* store.appendEvents(events);
    }
  }).pipe(Effect.provide(Store.layer({ filename: join(dir, "cerium.db") }))),
);
writeFileSync(join(dir, "staged-at"), new Date(now + 20_000).toISOString());
console.log(`Staged ${staged.length} threads in ${dir}.`);
