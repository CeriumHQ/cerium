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

/** The repeats that watch GitHub rather than a clock or CI; a machine before `GITHUB_AUTOMATIONS_RPC_VERSION` has none. */
export const gitHubRepeats = [
  "PullRequestReview",
  "PullRequestConflicts",
  "IssueAssigned",
  "IssueLabeled",
] as const satisfies ReadonlyArray<Repeat>;

export const isGitHubRepeat = (repeat: Repeat): boolean =>
  (gitHubRepeats as ReadonlyArray<Repeat>).includes(repeat);

/** What an issue trigger's thread does with the issue. */
export type IssueAction = "triage" | "draftPr";

export const issueActionLabel: Record<IssueAction, string> = {
  triage: "Triage it",
  draftPr: "Draft a PR",
};

export const issueActionHint: Record<IssueAction, string> = {
  triage: "Read the issue, find the cause, and write up a plan",
  draftPr: "Implement the issue, run checks, and open a draft pull request when ready",
};

/** The label an issue-label trigger starts with. */
export const DEFAULT_ISSUE_LABEL = "agent-ready";

export const repeatLabel: Record<Repeat, string> = {
  Hourly: "Every hour",
  Daily: "Every day",
  Weekdays: "Weekdays",
  CiFailed: "When CI fails",
  PullRequestReview: "PR review needed",
  PullRequestConflicts: "PR has conflicts",
  IssueAssigned: "Issue assigned",
  IssueLabeled: "Issue labeled",
};

export const repeatHint: Record<Repeat, string> = {
  Hourly: "At the same minute past each hour",
  Daily: "Once a day, at a time",
  Weekdays: "Monday to Friday, at a time",
  CiFailed: "On a commit an agent pushed in the project",
  PullRequestReview: "Review requested of you, or new comments on your PRs",
  PullRequestConflicts: "One of your pull requests can't merge cleanly",
  IssueAssigned: "An issue is assigned to you, or someone you name",
  IssueLabeled: "An issue gets a label, such as agent-ready",
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
    case "PullRequestReview":
      return "On PR review requests or comments";
    case "PullRequestConflicts":
      return "When your PR has conflicts";
    case "IssueAssigned":
      return when.assignee
        ? `When an issue is assigned to ${when.assignee}`
        : "When an issue is assigned to you";
    case "IssueLabeled":
      return `When an issue gets ${when.label}`;
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
      return run.detail ?? "Triggered";
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
  /** The GitHub user an `IssueAssigned` trigger watches; blank is whoever `gh` is signed in as. */
  readonly assignee: string;
  /** The label an `IssueLabeled` trigger watches. */
  readonly label: string;
  /** What an issue trigger's thread does with the issue. */
  readonly issueAction: IssueAction;
  /** A model from another lab reviews each run's work once it's done. */
  readonly reviewOnCompletion: boolean;
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
  assignee: "",
  label: DEFAULT_ISSUE_LABEL,
  issueAction: "triage",
  reviewOnCompletion: false,
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
  assignee: automation.when._tag === "IssueAssigned" ? (automation.when.assignee ?? "") : "",
  label: automation.when._tag === "IssueLabeled" ? automation.when.label : DEFAULT_ISSUE_LABEL,
  issueAction:
    automation.when._tag === "IssueAssigned" || automation.when._tag === "IssueLabeled"
      ? automation.when.action
      : "triage",
  reviewOnCompletion: automation.reviewOnCompletion === true,
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
    case "PullRequestReview":
      return { _tag: "PullRequestReview" };
    case "PullRequestConflicts":
      return { _tag: "PullRequestConflicts" };
    case "IssueAssigned": {
      const assignee = draft.assignee.trim().replace(/^@/, "");
      return {
        _tag: "IssueAssigned",
        ...(assignee === "" ? {} : { assignee }),
        action: draft.issueAction,
      };
    }
    case "IssueLabeled":
      return { _tag: "IssueLabeled", label: draft.label.trim(), action: draft.issueAction };
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
  if (draft.repeat === "IssueLabeled" && draft.label.trim() === "") return { missing: "Name the label" };
  const effort =
    draft.effort !== undefined && model.efforts.includes(draft.effort) ? draft.effort : undefined;
  return {
    input: {
      name: name.slice(0, MAX_AUTOMATION_NAME),
      prompt: draft.prompt,
      project: draft.project,
      // A GitHub trigger's thread always works in a worktree, never the project's own checkout.
      worktree: draft.worktree || isGitHubRepeat(draft.repeat),
      lead: {
        provider: model.provider,
        model: model.id,
        ...(effort === undefined ? {} : { effort }),
        ...(draft.autoEffort ? { autoEffort: true } : {}),
        access: draft.access,
      },
      when: whenOf(draft),
      ...(draft.onLimit ? { onLimit: draft.onLimit } : {}),
      ...(draft.reviewOnCompletion ? { reviewOnCompletion: true } : {}),
    },
  };
};

/** Whether the form says something other than what's saved. */
export const edited = (draft: Draft, automation: Automation | undefined): boolean =>
  automation === undefined || JSON.stringify(draft) !== JSON.stringify(draftOf(automation));
