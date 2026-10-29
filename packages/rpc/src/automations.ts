import {
  AccessMode,
  EpochMillis,
  LenientArray,
  LimitPolicy,
  ProviderId,
  ReasoningEffort,
  ThreadId,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// Automations: a prompt the user saved with a project and a model, which the machine's backend
// starts a work thread from on a schedule or when something happens, such as CI failing on a commit
// an agent pushed. They run while Cerium runs, the tray included, and the threads they start land in
// the inbox like any other.

/** The longest name an automation takes, so its threads' titles keep room for when they ran. */
export const MAX_AUTOMATION_NAME = 60;

/** The longest prompt an automation takes. */
export const MAX_AUTOMATION_PROMPT = 20_000;

const MinuteOfHour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 }));
/** Minutes since midnight, in the machine's own time zone. */
const MinuteOfDay = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }));

/** Every hour, at `minute` past. */
export const Hourly = Schema.TaggedStruct("Hourly", { minute: MinuteOfHour });
/** Every day at `at`, minutes since midnight in the machine's time zone. */
export const Daily = Schema.TaggedStruct("Daily", { at: MinuteOfDay });
/** Monday to Friday at `at`, minutes since midnight in the machine's time zone. */
export const Weekdays = Schema.TaggedStruct("Weekdays", { at: MinuteOfDay });

export const AutomationSchedule = Schema.Union([Hourly, Daily, Weekdays]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

/** CI failed on a commit an agent pushed with Cerium's `push` tool, in the automation's project. */
export const CiFailed = Schema.TaggedStruct("CiFailed", {});

export const AutomationTrigger = Schema.Union([CiFailed]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

/** When an automation starts a thread: a schedule's times, or a trigger's event. */
export const AutomationWhen = Schema.Union([Hourly, Daily, Weekdays, CiFailed]);
export type AutomationWhen = typeof AutomationWhen.Type;

/** The lead each run's thread starts with. */
export const AutomationLead = Schema.Struct({
  provider: ProviderId,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
  /** The lead starts on Auto, where the effort router is on. */
  autoEffort: Schema.optionalKey(Schema.Boolean),
  access: AccessMode,
});
export type AutomationLead = typeof AutomationLead.Type;

/** What the user writes of an automation. */
export const AutomationInput = Schema.Struct({
  name: Schema.Trimmed.check(Schema.isBetweenLength(1, MAX_AUTOMATION_NAME)),
  prompt: Schema.String.check(Schema.isBetweenLength(1, MAX_AUTOMATION_PROMPT)),
  /** The project folder each run's thread works in. */
  project: Schema.NonEmptyString,
  /** Each run works in a git worktree of its own, off the project's current branch. */
  worktree: Schema.Boolean,
  lead: AutomationLead,
  when: AutomationWhen,
  /**
   * What each run's thread does when its harness's limit runs out; absent follows the setting for all
   * threads. Since `RPC_VERSION` 41.
   */
  onLimit: Schema.optionalKey(LimitPolicy),
});
export type AutomationInput = typeof AutomationInput.Type;

export const Automation = Schema.Struct({
  ...AutomationInput.fields,
  id: Schema.NonEmptyString,
  /** A paused automation starts nothing until it's resumed; what it missed meanwhile is dropped. */
  paused: Schema.Boolean,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type Automation = typeof Automation.Type;

/**
 * Why a run happened: its scheduled time, a scheduled time missed while Cerium was closed or the
 * computer slept, its trigger, or the user's Run now.
 */
export const AutomationRunCause = Schema.Literals(["schedule", "missed", "trigger", "manual"]);
export type AutomationRunCause = typeof AutomationRunCause.Type;

/** One time an automation went off: the thread it started, or why it didn't start one. */
export const AutomationRun = Schema.Struct({
  id: Schema.NonEmptyString,
  at: EpochMillis,
  cause: AutomationRunCause,
  /** The scheduled time a `missed` run stood in for. */
  dueAt: Schema.optionalKey(EpochMillis),
  /** What set it off, in a line ("CI failed on main at 1a2b3c4"). */
  detail: Schema.optionalKey(Schema.String),
  /** The thread it started. */
  threadId: Schema.optionalKey(ThreadId),
  /** Why it started no thread, on purpose: the last run still works, or a missed time was dropped. */
  skipped: Schema.optionalKey(Schema.String),
  /** Why it couldn't start a thread, in plain words. */
  failed: Schema.optionalKey(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;

/** An automation as its page shows it: when it next runs, and its last runs, newest first. */
export const AutomationView = Schema.Struct({
  automation: Automation,
  /** The next scheduled time; absent for a trigger, or while paused. */
  nextAt: Schema.optionalKey(EpochMillis),
  runs: LenientArray(AutomationRun),
});
export type AutomationView = typeof AutomationView.Type;

export const AutomationRpcs = RpcGroup.make(
  /** Every automation of the machine, oldest first, now and after every change. Since `RPC_VERSION` 36. */
  Rpc.make("WatchAutomations", { success: LenientArray(AutomationView), stream: true }),
  /** Creates an automation, or with `id` replaces what the user wrote of one. Since `RPC_VERSION` 36. */
  Rpc.make("SaveAutomation", {
    payload: { id: Schema.optionalKey(Schema.NonEmptyString), input: AutomationInput },
    success: Automation,
    error: CeriumError,
  }),
  /** Pauses an automation or resumes it. Since `RPC_VERSION` 36. */
  Rpc.make("PauseAutomation", {
    payload: { id: Schema.NonEmptyString, paused: Schema.Boolean },
    error: CeriumError,
  }),
  /** Deletes an automation; the threads it started stay. Since `RPC_VERSION` 36. */
  Rpc.make("DeleteAutomation", { payload: { id: Schema.NonEmptyString }, error: CeriumError }),
  /** Starts a run of an automation now, paused or not. Since `RPC_VERSION` 36. */
  Rpc.make("RunAutomation", {
    payload: { id: Schema.NonEmptyString },
    success: AutomationRun,
    error: CeriumError,
  }),
);

// ---------------------------------------------------------------------------------------------
// Schedule times, in the machine's time zone

const HOUR = 60 * 60 * 1000;

/** Whether `when` is a schedule rather than a trigger. */
export const isSchedule = (when: AutomationWhen): when is AutomationSchedule => when._tag !== "CiFailed";

const isWeekday = (date: Date) => date.getDay() !== 0 && date.getDay() !== 6;

/** The day of `time` at `at` minutes past its midnight, in local time. */
const onDay = (time: number, at: number, dayOffset = 0): Date => {
  const day = new Date(time);
  day.setDate(day.getDate() + dayOffset);
  day.setHours(Math.floor(at / 60), at % 60, 0, 0);
  return day;
};

/** The latest time `schedule` comes round at or before `now`. */
export const previousSlot = (schedule: AutomationSchedule, now: number): number => {
  if (schedule._tag === "Hourly") {
    const slot = new Date(now);
    slot.setMinutes(schedule.minute, 0, 0);
    return slot.getTime() > now ? slot.getTime() - HOUR : slot.getTime();
  }
  for (let offset = 0; ; offset--) {
    const slot = onDay(now, schedule.at, offset);
    if (slot.getTime() <= now && (schedule._tag === "Daily" || isWeekday(slot))) return slot.getTime();
  }
};

/** The first time `schedule` comes round after `now`. */
export const nextSlot = (schedule: AutomationSchedule, now: number): number => {
  if (schedule._tag === "Hourly") {
    const slot = new Date(now);
    slot.setMinutes(schedule.minute, 0, 0);
    return slot.getTime() > now ? slot.getTime() : slot.getTime() + HOUR;
  }
  for (let offset = 0; ; offset++) {
    const slot = onDay(now, schedule.at, offset);
    if (slot.getTime() > now && (schedule._tag === "Daily" || isWeekday(slot))) return slot.getTime();
  }
};
