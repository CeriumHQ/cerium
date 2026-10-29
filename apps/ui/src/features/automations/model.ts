import type { AccessMode, LimitPolicy, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import {
  MAX_AUTOMATION_NAME,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationWhen,
} from "@cerium/rpc";

import type { ThreadSummary } from "../threads/model.ts";

// What the Automations page says about an automation and its runs, and the form it's edited in.

/** How an automation goes off, as its form's first select offers it. */
export type Repeat = AutomationWhen["_tag"];

export const repeatLabel: Record<Repeat, string> = {
  Hourly: "Every hour",
  Daily: "Every day",
  Weekdays: "Weekdays",
  CiFailed: "When CI fails",
};

export const repeatHint: Record<Repeat, string> = {
  Hourly: "At the same minute past each hour",
  Daily: "Once a day, at a time",
  Weekdays: "Monday to Friday, at a time",
  CiFailed: "On a commit an agent pushed in the project",
};

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Minutes since midnight as the user's clock reads them: "9:00 AM", or "09:00". */
export const clockLabel = (minutes: number): string =>
  clockFormat.format(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));

/** When an automation goes off, in a few words: "Weekdays at 9:00 AM". */
export const whenLabel = (when: AutomationWhen): string => {
  switch (when._tag) {
    case "Hourly":
      return when.minute === 0 ? "Every hour" : `Every hour at :${String(when.minute).padStart(2, "0")}`;
    case "Daily":
      return `Every day at ${clockLabel(when.at)}`;
    case "Weekdays":
      return `Weekdays at ${clockLabel(when.at)}`;
    case "CiFailed":
      return "When CI fails";
  }
};

const startOfDay = (time: number) => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A time soon, as a schedule names it: "in 12 min", "Today 9:00 AM", "Tomorrow 9:00 AM", "Mon 9:00 AM". */
export const soonLabel = (at: number, now: number): string => {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 60) return minutes <= 1 ? "in a minute" : `in ${minutes} min`;
  const time = clockFormat.format(at);
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return days < 7 ? `${weekday.format(at)} ${time}` : `${dateFormat.format(at)} ${time}`;
};

/** `soonLabel` inside a sentence: "next tomorrow 9:00 AM", with a weekday or a month kept capitalised. */
export const soonPhrase = (at: number, now: number): string =>
  soonLabel(at, now).replace(/^(Today|Tomorrow)\b/, (word) => word.toLowerCase());

/** A past time, as a run's row names it: "Today 9:00 AM", "Yesterday 9:00 AM", "Oct 21 9:00 AM". */
export const pastLabel = (at: number, now: number): string => {
  const time = clockFormat.format(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${dateFormat.format(at)} ${time}`;
};

/** How a run turned out, joining the thread it started where the window still knows it. */
export type RunState = "working" | "needsYou" | "done" | "failed" | "skipped" | "notStarted";

export const runState = (run: AutomationRun, thread: ThreadSummary | undefined): RunState => {
  if (run.skipped !== undefined) return "skipped";
  if (run.threadId === undefined) return "notStarted";
  if (run.failed !== undefined) return "failed";
  switch (thread?.status) {
    case "running":
      return "working";
    case "awaitingApproval":
      return "needsYou";
    case "failed":
      return "failed";
    default:
      return "done";
  }
};

export const runStateLabel: Record<RunState, string> = {
  working: "Working",
  needsYou: "Needs you",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  notStarted: "Didn't start",
};

/** What set a run off, in a word or a line. */
export const runCauseLabel = (run: AutomationRun): string => {
  switch (run.cause) {
    case "schedule":
      return "On schedule";
    case "missed":
      return "Missed while closed";
    case "manual":
      return run.detail === undefined ? "Run now" : `Run now · ${run.detail}`;
    case "trigger":
      return run.detail ?? "CI failed";
  }
};

/** An automation's form, as the user writes it; turned into an `AutomationInput` once it's whole. */
export interface Draft {
  readonly name: string;
  readonly prompt: string;
  readonly project: string | undefined;
  readonly worktree: boolean;
  /** The model's `modelKey`. */
  readonly model: string | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly autoEffort: boolean;
  readonly access: AccessMode;
  /** What each run's thread does when its harness's limit runs out; absent follows the setting. */
  readonly onLimit: LimitPolicy | undefined;
  readonly repeat: Repeat;
  /** Past the hour, for `Hourly`. */
  readonly minute: number;
  /** Minutes since midnight, for `Daily` and `Weekdays`. */
  readonly at: number;
}

/** A new automation's form: weekdays at nine, with the composer's own defaults for the rest. */
export const newDraft = (defaults: {
  readonly project: string | undefined;
  readonly model: string | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly access: AccessMode;
}): Draft => ({
  name: "",
  prompt: "",
  project: defaults.project,
  worktree: true,
  model: defaults.model,
  effort: defaults.effort,
  autoEffort: false,
  access: defaults.access,
  onLimit: undefined,
  repeat: "Weekdays",
  minute: 0,
  at: 9 * 60,
});

/** A saved automation's form. */
export const draftOf = (automation: Automation): Draft => ({
  name: automation.name,
  prompt: automation.prompt,
  project: automation.project,
  worktree: automation.worktree,
  model: `${automation.lead.provider}/${automation.lead.model}`,
  effort: automation.lead.effort,
  autoEffort: automation.lead.autoEffort === true,
  access: automation.lead.access,
  onLimit: automation.onLimit,
  repeat: automation.when._tag,
  minute: automation.when._tag === "Hourly" ? automation.when.minute : 0,
  at: automation.when._tag === "Daily" || automation.when._tag === "Weekdays" ? automation.when.at : 9 * 60,
});

const whenOf = (draft: Draft): AutomationWhen => {
  switch (draft.repeat) {
    case "Hourly":
      return { _tag: "Hourly", minute: draft.minute };
    case "Daily":
      return { _tag: "Daily", at: draft.at };
    case "Weekdays":
      return { _tag: "Weekdays", at: draft.at };
    case "CiFailed":
      return { _tag: "CiFailed" };
  }
};

/** The form as an automation to save, or what it still lacks, in a few words for the save button's tip. */
export const inputOf = (
  draft: Draft,
  model: ModelInfo | undefined,
): { readonly input: AutomationInput } | { readonly missing: string } => {
  const name = draft.name.trim();
  if (name === "") return { missing: "Name it" };
  if (draft.prompt.trim() === "") return { missing: "Say what the agent should do" };
  if (draft.project === undefined) return { missing: "Pick a project" };
  if (model === undefined) return { missing: "Pick a model" };
  const effort =
    draft.effort !== undefined && model.efforts.includes(draft.effort) ? draft.effort : undefined;
  return {
    input: {
      name: name.slice(0, MAX_AUTOMATION_NAME),
      prompt: draft.prompt,
      project: draft.project,
      worktree: draft.worktree,
      lead: {
        provider: model.provider,
        model: model.id,
        ...(effort === undefined ? {} : { effort }),
        ...(draft.autoEffort ? { autoEffort: true } : {}),
        access: draft.access,
      },
      when: whenOf(draft),
      ...(draft.onLimit ? { onLimit: draft.onLimit } : {}),
    },
  };
};

/** Whether the form says something other than what's saved. */
export const edited = (draft: Draft, automation: Automation | undefined): boolean =>
  automation === undefined || JSON.stringify(draft) !== JSON.stringify(draftOf(automation));
