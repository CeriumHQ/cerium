import type { HookStep, PushCheck, PushRecord } from "@cerium/rpc";

import { outputText, type ToolBlock } from "./tools.ts";

// What a push the agent made with Cerium's `push` tool says to the user: written for someone new to
// git and CI, so its checks read as a checklist in plain words.

export const isPushCall = (block: { readonly kind: string; readonly toolName?: string }): boolean =>
  block.kind === "tool" &&
  block.toolName !== undefined &&
  block.toolName.startsWith("mcp__") &&
  /^mcp__[^_]+__push$/.test(block.toolName);

/** What the tool answered, once it did. */
export interface PushAnswer {
  readonly status: "pushed" | "rejected" | "failed" | "checking" | "denied";
  readonly pushId?: string;
  readonly note: string;
}

export const answerOf = (call: ToolBlock): PushAnswer | undefined => {
  if (call.output === undefined) return undefined;
  try {
    const parsed = JSON.parse(outputText(call.output)) as Partial<PushAnswer>;
    return typeof parsed.status === "string" && typeof parsed.note === "string"
      ? (parsed as PushAnswer)
      : undefined;
  } catch {
    return undefined;
  }
};

/** How long a call still waiting for its answer looks back for the push it started. */
const STARTED_WITHIN = 2 * 60_000;

/**
 * The push a call made: the one its answer names, or, while it waits for that answer, the thread's
 * newest push still under way (an agent pushes one at a time).
 */
export const pushOf = (
  call: ToolBlock,
  pushes: ReadonlyArray<PushRecord>,
  now: number,
): PushRecord | undefined => {
  const answer = answerOf(call);
  if (answer !== undefined) {
    return answer.pushId === undefined ? undefined : pushes.find((push) => push.id === answer.pushId);
  }
  if (call.status !== "running") return undefined;
  return pushes.findLast(
    (push) => push.stage === "checking" || push.stage === "pushing" || now - push.createdAt < STARTED_WITHIN,
  );
};

/** Whether a newer push followed this one in the thread, which folds it to a line. */
export const supersededBy = (push: PushRecord, pushes: ReadonlyArray<PushRecord>): boolean =>
  pushes.some((other) => other.createdAt > push.createdAt && other.id !== push.id);

// ---------------------------------------------------------------------------------------------
// Words

/** A duration as a person says it: "18s", "9m 30s", "1h 5m"; `rough` leaves the seconds off past a minute. */
export const duration = (ms: number, rough = false): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return rough ? `${minutes}m` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** "your change", "your 3 changes". */
export const changes = (count: number) => (count === 1 ? "your change" : `your ${count} changes`);

export type Tone = "running" | "passed" | "failed" | "quiet";

export interface Headline {
  readonly tone: Tone;
  readonly title: string;
  /** Said at the header's end: how far the checks are, and for how long. */
  readonly meta?: string;
  /** A line under the header, for why there are no checks. */
  readonly note?: string;
}

const isDone = (check: PushCheck) =>
  check.state === "passed" ||
  check.state === "failed" ||
  check.state === "cancelled" ||
  check.state === "skipped";

/** When the checks started, from the first one that did. */
const checksStarted = (push: PushRecord) => {
  const starts = (push.ci?.checks ?? []).flatMap((check) =>
    check.startedAt === undefined ? [] : [check.startedAt],
  );
  return starts.length === 0 ? undefined : Math.min(...starts);
};

/** Where the changes went, as the user knows it. */
const destination = (push: PushRecord) => (push.repository === undefined ? push.remote : "GitHub");

export const headline = (push: PushRecord, now: number): Headline => {
  const sent = changes(push.commits.length);
  switch (push.stage) {
    case "checking":
      return {
        tone: "running",
        title: "Checking your changes on your computer",
        meta: duration(now - push.createdAt, true),
      };
    case "pushing":
      return { tone: "running", title: `Sending ${sent}` };
    case "rejected":
      return { tone: "failed", title: "The push was turned away" };
    case "failed":
      return {
        tone: "failed",
        title: push.hook.some((step) => step.state === "failed")
          ? "The checks on your computer failed"
          : "The push didn't go through",
      };
    case "pushed":
      break;
  }
  if (push.commits.length === 0) return { tone: "quiet", title: "Nothing new to send" };
  const ci = push.ci;
  if (ci === undefined || ci.state === "waiting") {
    return { tone: "running", title: `Waiting for GitHub to check ${sent}` };
  }
  const total = ci.checks.length;
  const started = checksStarted(push);
  const took = (end: number) => (started === undefined ? undefined : duration(end - started, true));
  switch (ci.state) {
    case "running": {
      const done = ci.checks.filter(isDone).length;
      const elapsed = took(now);
      return {
        tone: "running",
        title: `GitHub is checking ${sent}`,
        meta: [`${done} of ${total} done`, ...(elapsed === undefined ? [] : [elapsed])].join(" · "),
      };
    }
    case "passed": {
      const elapsed = took(ci.finishedAt ?? now);
      return {
        tone: "passed",
        title: total === 1 ? "The check passed" : `All ${total} checks passed`,
        ...(elapsed === undefined ? {} : { meta: elapsed }),
      };
    }
    case "failed": {
      const failed = ci.checks.filter((check) => check.state === "failed").length;
      return {
        tone: "failed",
        title:
          failed === 0
            ? "A check failed"
            : total === 1
              ? "The check failed"
              : `${failed} of ${total} checks failed`,
      };
    }
    case "cancelled":
      return { tone: "quiet", title: "The checks were cancelled" };
    case "superseded":
      return { tone: "quiet", title: "A newer push replaced these checks" };
    case "none":
      return {
        tone: "passed",
        title: `Sent ${sent} to ${destination(push)}`,
        note: ci.note ?? "No checks ran on GitHub for this push.",
      };
    case "unavailable":
      return {
        tone: "passed",
        title: `Sent ${sent} to ${destination(push)}`,
        ...(ci.note === undefined ? {} : { note: ci.note }),
      };
  }
};

/** What a check's row says at its end. */
export const checkStatus = (check: PushCheck, now: number): string => {
  const took = (end: number) =>
    check.startedAt === undefined ? "" : ` · ${duration(end - check.startedAt)}`;
  switch (check.state) {
    case "passed":
      return `Passed${took(check.completedAt ?? now)}`;
    case "failed":
      return `Failed${took(check.completedAt ?? now)}`;
    case "running":
      return check.startedAt === undefined ? "Running" : `Running · ${duration(now - check.startedAt, true)}`;
    case "queued":
      return "Starting";
    case "waiting":
      return "Waiting for the others";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
};

/** What a step of the checks on the user's computer says at its end. */
export const stepStatus = (step: HookStep, now: number): string => {
  const took = duration((step.endedAt ?? now) - step.startedAt, step.state === "running");
  switch (step.state) {
    case "running":
      return `Running · ${took}`;
    case "passed":
      return `Passed · ${took}`;
    case "failed":
      return `Failed · ${took}`;
    case "done":
      return `Done · ${took}`;
  }
};

/** The line between the header and the checks: what happened before GitHub got the changes. */
export const sentLine = (push: PushRecord): string =>
  push.hook.length > 0
    ? `Checked on your computer first, then sent to ${destination(push)}`
    : `Sent to ${destination(push)}`;

/** The one line a push folds to once a newer one followed it. */
export const foldedLine = (push: PushRecord, now: number): string => {
  const { title } = headline(push, now);
  if (push.stage !== "pushed" || push.commits.length === 0) return title;
  const count = push.commits.length;
  return `Pushed ${count === 1 ? "1 change" : `${count} changes`} · ${title}`;
};

/** The run a push's checks are seen on GitHub at: a failed one first. */
export const runUrl = (push: PushRecord): string | undefined => {
  const runs = (push.ci?.runs ?? []).filter((run) => run.url !== "");
  return (runs.find((run) => run.state === "failed") ?? runs[0])?.url;
};
