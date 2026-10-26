import type {
  CheckFailure,
  PushCheckState as CheckState,
  CiState,
  HookStep,
  PushCheck,
  PushRecord,
  PushRun,
  PushStage,
} from "@cerium/rpc";

import { explainFailure } from "./gitBranches.ts";

// What a push's output and GitHub's answers mean, kept apart from running them (pushes.ts).

// ---------------------------------------------------------------------------------------------
// The pre-push hook and git

/** How far a push's output has got: the hook's steps, and whether git went on to send. */
export interface PushProgress {
  readonly hook: ReadonlyArray<HookStep>;
  readonly sending: boolean;
}

export const NO_PROGRESS: PushProgress = { hook: [], sending: false };

/** A step's start (`> label`) and its result (`< label: passed`), as Cerium's own pre-push hook prints them. */
const STEP_START = /^> (\S.*?)\s*$/;
const STEP_END = /^< (\S.*?): (passed|failed)\s*$/;

export const isStepEnd = (line: string) => STEP_END.test(line);

/**
 * Git's own lines once the hook is done and it talks to the remote. `error: failed to push` isn't
 * one: git says it after a failed hook too.
 */
const SENDING =
  /^(?:To \S|Everything up-to-date|Enumerating objects:|Counting objects:|Compressing objects:|Writing objects:|Total \d|remote: |\s*! \[|\s+[0-9a-f]{4,}\.\.\.?[0-9a-f]{4,}\s|\s*\* \[new (?:branch|tag)\])/;

const close = (step: HookStep, state: HookStep["state"], at: number): HookStep =>
  step.state === "running" ? { ...step, state, endedAt: at } : step;

/** `progress` after one more line of output, printed at `at`. */
export const readLine = (progress: PushProgress, line: string, at: number): PushProgress => {
  if (progress.sending) return progress;
  if (SENDING.test(line)) {
    return { hook: progress.hook.map((step) => close(step, "passed", at)), sending: true };
  }
  const ended = STEP_END.exec(line);
  if (ended !== null) {
    const [, label = "", result] = ended;
    const index = progress.hook.findLastIndex((step) => step.label === label);
    if (index === -1) return progress;
    const state = result === "passed" ? "passed" : "failed";
    return {
      ...progress,
      hook: progress.hook.map((step, position) =>
        position === index ? { ...step, state, endedAt: step.endedAt ?? at } : step,
      ),
    };
  }
  const started = STEP_START.exec(line);
  if (started !== null) {
    return {
      ...progress,
      hook: [
        ...progress.hook.map((step) => close(step, "done", at)),
        { label: started[1] ?? "", state: "running", startedAt: at },
      ],
    };
  }
  return progress;
};

/**
 * The hook's steps once git exited: all passed when the push went ahead, else the ones still running
 * failed, or the last when none said it did.
 */
export const finishHook = (
  hook: ReadonlyArray<HookStep>,
  passed: boolean,
  at: number,
): ReadonlyArray<HookStep> => {
  if (passed) {
    return hook.map((step) =>
      step.state === "failed" ? step : { ...step, state: "passed", endedAt: step.endedAt ?? at },
    );
  }
  const closed = hook.map((step) => close(step, "failed", at));
  if (closed.some((step) => step.state === "failed")) return closed;
  return closed.map((step, index) => (index === closed.length - 1 ? { ...step, state: "failed" } : step));
};

/** How `git push` ended, from its exit code and output, and why in plain words when it didn't land. */
export const pushOutcome = (
  code: number,
  output: string,
  sending: boolean,
): { readonly stage: Exclude<PushStage, "checking" | "pushing">; readonly message?: string } => {
  const text = output.replaceAll("\r", "");
  if (code === 0) {
    return /everything up-to-date/i.test(text)
      ? { stage: "pushed", message: "Everything was already pushed." }
      : { stage: "pushed" };
  }
  if (/\[rejected\]|non-fast-forward|fetch first|updates were rejected/i.test(text)) {
    return {
      stage: "rejected",
      message: "The remote has commits this branch doesn't: rebase onto them and push again.",
    };
  }
  if (sending || /^fatal:/m.test(text)) {
    return { stage: "failed", message: explainFailure(text, "Git couldn't push.") };
  }
  return { stage: "failed", message: "The pre-push checks failed, so nothing was pushed." };
};

/** At most `limit` characters of `text`, from its end, cut at a line. */
export const tailOf = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
};

// ---------------------------------------------------------------------------------------------
// GitHub Actions

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const time = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};
const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** A run's or job's `status` and `conclusion` as one state. */
export const stateOf = (status: unknown, conclusion: unknown): CheckState => {
  if (status !== "completed") {
    if (status === "in_progress") return "running";
    if (status === "waiting") return "waiting";
    return "queued";
  }
  switch (conclusion) {
    case "success":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
    case "stale":
      return "skipped";
    default:
      return "failed";
  }
};

export const finished = (state: CheckState) =>
  state === "passed" || state === "failed" || state === "cancelled" || state === "skipped";

const listOf = (answer: unknown, key: string): ReadonlyArray<unknown> => {
  const list = record(answer)?.[key];
  return Array.isArray(list) ? (list as Array<unknown>) : [];
};

/** The workflow runs `GET repos/o/r/actions/runs?head_sha=…` lists, oldest first. */
export const runsOf = (
  answer: unknown,
): ReadonlyArray<PushRun & { readonly workflowId?: string; readonly createdAt?: number }> =>
  listOf(answer, "workflow_runs")
    .flatMap((value) => {
      const run = record(value);
      const id = run?.["id"];
      const url = text(run?.["html_url"]);
      if (run === undefined || (typeof id !== "number" && typeof id !== "string") || url === undefined)
        return [];
      const number = run["run_number"];
      const attempt = run["run_attempt"];
      const workflow = run["workflow_id"];
      return [
        {
          id: String(id),
          name: text(run["name"]) ?? text(run["display_title"]) ?? "Workflow",
          ...optional("number", typeof number === "number" ? number : undefined),
          attempt: typeof attempt === "number" ? attempt : 1,
          url,
          state: stateOf(run["status"], run["conclusion"]),
          ...optional(
            "workflowId",
            typeof workflow === "number" || typeof workflow === "string" ? String(workflow) : undefined,
          ),
          ...optional("createdAt", time(run["created_at"])),
        },
      ];
    })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));

/** A run's jobs, from `GET repos/o/r/actions/runs/{id}/jobs`, as checks in GitHub's order. */
export const checksOf = (runId: string, answer: unknown): ReadonlyArray<PushCheck> =>
  listOf(answer, "jobs").flatMap((value) => {
    const job = record(value);
    const id = job?.["id"];
    if (job === undefined || (typeof id !== "number" && typeof id !== "string")) return [];
    const state = stateOf(job["status"], job["conclusion"]);
    const steps = Array.isArray(job["steps"]) ? (job["steps"] as Array<unknown>) : [];
    const failedStep =
      state === "failed"
        ? steps.map(record).find((step) => step?.["conclusion"] === "failure")?.["name"]
        : undefined;
    const startedAt = time(job["started_at"]);
    const completedAt = finished(state) ? time(job["completed_at"]) : undefined;
    return [
      {
        id: String(id),
        name: text(job["name"]) ?? "Job",
        state,
        runId,
        ...optional("startedAt", state === "queued" || state === "waiting" ? undefined : startedAt),
        ...optional("completedAt", completedAt),
        ...optional("url", text(job["html_url"])),
        ...optional("failedStep", text(failedStep)),
      },
    ];
  });

/**
 * Where the pushed commit's CI stands, from its runs and their checks; `superseded` and `none` are
 * the watcher's to say.
 */
export const rollup = (runs: ReadonlyArray<PushRun>, checks: ReadonlyArray<PushCheck>): CiState => {
  if (runs.length === 0) return "waiting";
  const states = [...runs.map((run) => run.state), ...checks.map((check) => check.state)];
  if (!states.every(finished)) return "running";
  if (states.includes("failed")) return "failed";
  if (states.includes("cancelled")) return "cancelled";
  return "passed";
};

/** Lines of a job's log the agent and the user see. */
export const LOG_LINES = 80;

/**
 * The end of a failed job's log, without GitHub's timestamps, group markers and the cleanup after the
 * failure, and its first error in a line.
 */
export const logTail = (
  log: string,
  lines = LOG_LINES,
): { readonly log: string; readonly summary?: string } => {
  const all = log
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
  const cleanup = all.findIndex((line) => /^Post job cleanup\./.test(line));
  const body = (cleanup === -1 ? all : all.slice(0, cleanup))
    .filter((line) => !/^##\[(?:endgroup|group)\]/.test(line) || /^##\[group\]Run /.test(line))
    .map((line) => line.replace(/^##\[group\]/, "").replace(/^##\[error\]/, "Error: "));
  const lastError = body.findLastIndex((line) => line.startsWith("Error: "));
  const end = lastError === -1 ? body.length : Math.min(body.length, lastError + 3);
  const kept = body.slice(Math.max(0, end - lines), end);
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
  // GitHub's own error line, else the test runner's count of what failed ("Tests  1 failed | 212 passed").
  const summary = (
    body
      .find((line) => line.startsWith("Error: ") && !/Process completed with exit code/.test(line))
      ?.replace(/^Error: /, "") ??
    body.findLast((line) => !line.startsWith("Error: ") && /\b\d+ (?:failed|failing|errors?)\b/i.test(line))
  )
    ?.replace(/\s+/g, " ")
    .trim();
  return { log: kept.join("\n"), ...optional("summary", summary === "" ? undefined : summary) };
};

// ---------------------------------------------------------------------------------------------
// What the agent is told

const short = (sha: string | undefined) => (sha === undefined ? "" : ` (${sha.slice(0, 7)})`);
const where = (push: PushRecord) => `${push.remote}/${push.branch}`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** How the push itself went, for the tool's answer or, when that answer said `checking`, a message. */
export const outcomeNote = (push: PushRecord): string => {
  switch (push.stage) {
    case "pushed":
      return push.commits.length === 0
        ? `Pushed ${where(push)}${short(push.head)}: ${push.message ?? "nothing new to send"}.`
        : `Pushed ${plural(push.commits.length, "commit")} to ${where(push)}${short(push.head)}. The CI result reaches you as a message when its checks finish; the user follows them in the thread.`;
    case "rejected":
      return `The push to ${where(push)} was rejected: ${push.message ?? "the remote moved"} Don't force push.`;
    case "failed": {
      const failed = push.hook.filter((step) => step.state === "failed").map((step) => step.label);
      const steps = failed.length === 0 ? "" : ` Failed: ${failed.join(", ")}.`;
      return `The push to ${where(push)} failed: ${push.message ?? "git couldn't push."}${steps}\nLast lines of the output:\n\`\`\`\n${tailOf(push.output, 4_000).trimEnd()}\n\`\`\`\nFix it and push again.`;
    }
    default:
      return `The pre-push checks for ${where(push)} are still running; how the push went reaches you as a message.`;
  }
};

/** What the agent is told once the pushed commit's CI finished; nothing while it runs. */
export const ciNote = (push: PushRecord): string | undefined => {
  const ci = push.ci;
  if (ci === undefined) return undefined;
  const subject = `CI for your push to ${where(push)}${short(push.head)}`;
  switch (ci.state) {
    case "passed":
      return `${subject} passed: ${plural(ci.checks.filter((check) => check.state === "passed").length, "check")}.`;
    case "failed":
      return failureNote(push);
    case "cancelled":
      return `${subject} was cancelled.`;
    case "superseded":
      return `${subject} was cancelled by a newer push's runs.`;
    case "none":
      return `${subject}: ${ci.note ?? "no CI runs started for it."}`;
    default:
      return undefined;
  }
};

/** The failed checks with the end of each one's log, for the agent to fix. */
export const failureNote = (push: PushRecord): string => {
  const ci = push.ci;
  const failed = ci?.checks.filter((check) => check.state === "failed") ?? [];
  const names = failed.map((check) => check.name);
  const head = `CI failed for your push to ${where(push)}${short(push.head)}: ${names.length === 0 ? "a run failed" : `${names.join(", ")} failed`}.`;
  return [head, ...failureDetails(push), "Fix what failed and push again."].join("\n\n");
};

/** Each failed check with the step it failed at and the end of its log, or the failed run's link. */
export const failureDetails = (push: PushRecord): ReadonlyArray<string> => {
  const ci = push.ci;
  const details = (ci?.failures ?? []).map((failure: CheckFailure) =>
    [
      `${failure.name}${failure.step === undefined ? "" : `, at step "${failure.step}"`}${failure.summary === undefined ? "" : `: ${failure.summary}`}`,
      ...(failure.log === "" ? [] : ["```", failure.log, "```"]),
      ...(failure.url === undefined ? [] : [failure.url]),
    ].join("\n"),
  );
  const run = ci?.runs.find((each) => each.state === "failed")?.url;
  return details.length === 0 && run !== undefined ? [run] : details;
};

/** The desktop notification's line once CI finished. */
export const ciHeadline = (push: PushRecord): string | undefined => {
  const ci = push.ci;
  if (ci === undefined) return undefined;
  const failed = ci.checks.filter((check) => check.state === "failed").length;
  if (ci.state === "passed") return `All ${plural(ci.checks.length, "check")} passed on ${push.branch}.`;
  if (ci.state === "failed") {
    return `${failed === 0 ? "A check" : plural(failed, "check")} failed on ${push.branch}.`;
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// Simulated CI, for tests and for seeing the thread's checks without pushing anywhere

const SIMULATED_JOBS: ReadonlyArray<{ readonly name: string; readonly seconds: number }> = [
  { name: "Lint and format", seconds: 6 },
  { name: "Types", seconds: 9 },
  { name: "Tests (Linux)", seconds: 16 },
  { name: "Tests (Windows)", seconds: 22 },
  { name: "Package (Windows)", seconds: 28 },
  { name: "Package (macOS)", seconds: 30 },
];

export const SIMULATED_FAILURE_LOG = [
  "Run bun run test --run",
  " ✓ packages/rpc/test/rpc.test.ts (12 tests) 41ms",
  " ✓ apps/backend/test/pushModel.test.ts (18 tests) 22ms",
  " ❯ apps/ui/test/transcript.test.ts (24 tests | 1 failed) 310ms",
  "   × folds an older push to one line",
  "     → expected 'checking' to be 'pushed'",
  "",
  " Test Files  1 failed | 211 passed (212)",
  "      Tests  1 failed | 212 passed (213)",
  "Error: Process completed with exit code 1.",
].join("\n");

/**
 * The checks a simulated run has `elapsed` milliseconds after it started: each job queues, runs for
 * its time and passes, but for one that fails when `outcome` is `fail`. Two seconds pass before runs
 * appear, as on GitHub.
 */
export const simulatedCi = (
  elapsed: number,
  outcome: "pass" | "fail",
  startedAt: number,
  attempt = 1,
): { readonly runs: ReadonlyArray<PushRun>; readonly checks: ReadonlyArray<PushCheck> } => {
  if (elapsed < 2_000) return { runs: [], checks: [] };
  const runId = `simulated-${attempt}`;
  const failing = outcome === "fail" ? "Tests (Linux)" : undefined;
  const checks = SIMULATED_JOBS.map((job, index): PushCheck => {
    const start = 2_000 + (index < 4 ? 0 : 8_000);
    const end = start + job.seconds * 1_000;
    const id = `${runId}-${index}`;
    if (elapsed < start) return { id, name: job.name, state: "waiting", runId };
    const base = { id, name: job.name, runId, startedAt: startedAt + start };
    if (elapsed < end) return { ...base, state: "running" };
    return job.name === failing
      ? { ...base, state: "failed", completedAt: startedAt + end, failedStep: "Test" }
      : { ...base, state: "passed", completedAt: startedAt + end };
  });
  const state = rollup([{ id: runId, name: "CI", attempt, url: "", state: "passed" }], checks);
  return {
    runs: [
      {
        id: runId,
        name: "CI",
        number: 1,
        attempt,
        url: "https://github.com/cerium/simulated/actions",
        state: state === "running" ? "running" : state === "failed" ? "failed" : "passed",
      },
    ],
    checks,
  };
};
