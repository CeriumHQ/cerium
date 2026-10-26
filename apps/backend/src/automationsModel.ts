import { MAX_THREAD_TITLE } from "@cerium/protocol";
import {
  nextSlot,
  previousSlot,
  type AutomationRun,
  type AutomationRunCause,
  type AutomationSchedule,
  type PushRecord,
} from "@cerium/rpc";

import { failureDetails } from "./pushModel.ts";

// What the automations' scheduler decides, kept apart from the service so it can be tested with
// any clock: whether a scheduled time has come, what to do about one missed while Cerium was closed
// or the computer slept, and what each run's thread is called and told.

/** How late a scheduled time may be noticed and still count as on time: the scheduler's tick, and some. */
export const ON_TIME_WITHIN = 2 * 60 * 1000;

/** How many runs each automation keeps to show. */
export const KEPT_RUNS = 20;

/** What the scheduler does about an automation's schedule at a tick. */
export type ScheduleStep =
  /** Nothing has come round since the time it last handled. */
  | { readonly _tag: "Wait" }
  /** A time came round, now or a while ago; `slot` is the one it handles. */
  | {
      readonly _tag: "Run";
      readonly slot: number;
      readonly cause: Extract<AutomationRunCause, "schedule" | "missed">;
    }
  /** A time was missed so long ago that the next is nearer: it's dropped for that one. */
  | { readonly _tag: "Drop"; readonly slot: number; readonly next: number };

/**
 * What to do at `now` about a schedule whose latest handled time is `handled`. A time noticed within
 * `ON_TIME_WITHIN` runs as scheduled. One noticed later, because Cerium was closed or the computer
 * slept, runs once as `missed`, however many came round meanwhile, while it's nearer than the next
 * time; past halfway to the next, it waits for that one instead.
 */
export const scheduleStep = (schedule: AutomationSchedule, handled: number, now: number): ScheduleStep => {
  const slot = previousSlot(schedule, now);
  if (slot <= handled) return { _tag: "Wait" };
  const late = now - slot;
  if (late <= ON_TIME_WITHIN) return { _tag: "Run", slot, cause: "schedule" };
  const next = nextSlot(schedule, now);
  return late < next - now ? { _tag: "Run", slot, cause: "missed" } : { _tag: "Drop", slot, next };
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A time as a run's title and notes put it: "Oct 26, 9:00 AM". */
export const whenLabel = (time: number): string => `${dayFormat.format(time)}, ${timeFormat.format(time)}`;

const sha = (push: PushRecord) => push.head?.slice(0, 7);

/** What set off a CI trigger, in a line: "CI failed on main at 1a2b3c4". */
export const ciDetail = (push: PushRecord): string =>
  `CI failed on ${push.branch}${sha(push) === undefined ? "" : ` at ${sha(push)}`}`;

/**
 * A run's thread title: the automation's name and when it ran, or for a CI trigger the branch and
 * commit, cut to fit a thread's title.
 */
export const runTitle = (name: string, at: number, push?: PushRecord): string => {
  const suffix =
    push === undefined ? whenLabel(at) : `${push.branch}${sha(push) === undefined ? "" : ` ${sha(push)}`}`;
  const title = `${name} · ${suffix}`;
  return title.length <= MAX_THREAD_TITLE ? title : `${title.slice(0, MAX_THREAD_TITLE - 1)}…`;
};

/**
 * The first message of a CI trigger's thread: the user's prompt, then what failed on which commit,
 * with the end of each failed check's log.
 */
export const ciPrompt = (prompt: string, push: PushRecord, pushedFrom: string | undefined): string => {
  const commits = push.commits.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}`);
  return [
    prompt.trim(),
    "---",
    `${ciDetail(push)}${push.repository === undefined ? "" : ` in ${push.repository}`}, pushed to ${push.remote}${pushedFrom === undefined ? "" : ` from the thread "${pushedFrom}"`}.${push.head === undefined ? "" : ` The commit is ${push.head}.`}`,
    ...(commits.length === 0 ? [] : [`Commits pushed:\n${commits.join("\n")}`]),
    ...failureDetails(push),
  ].join("\n\n");
};

/** An automation's runs with `run` added, newest first, as many as are kept. */
export const withRun = (
  runs: ReadonlyArray<AutomationRun>,
  run: AutomationRun,
): ReadonlyArray<AutomationRun> => [run, ...runs].slice(0, KEPT_RUNS);

/** Whether two folders are the same, ignoring case on Windows and a trailing separator. */
export const sameFolder = (a: string, b: string, platform: NodeJS.Platform = process.platform): boolean => {
  const tidy = (folder: string) => {
    const unified = folder.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? unified.toLowerCase() : unified;
  };
  return tidy(a) === tidy(b);
};
