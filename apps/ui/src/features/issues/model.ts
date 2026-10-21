import type { IssueDetail, IssueFilters, IssueSummary, RepositoryPermission } from "@cerium/rpc";

// What the Issues tab and the issue viewer work out for themselves, as plain functions: which filters
// are set, how an issue's state reads, and the brief a thread that looks into an issue starts from.

/** The `RPC_VERSION` that brought the issue calls; an older machine has no Issues tab. */
export const ISSUES_VERSION = 17;

/** How many entries of an issue's conversation the viewer asks for at first, and for each time it reads on. */
export const ITEMS_STEP = 100;

/** The most entries one reading holds (see `MAX_ISSUE_ITEMS`). */
export const ITEMS_LIMIT = 500;

// ---------------------------------------------------------------------------------------------
// Filters

/** The open issues, with nothing narrowing them. */
export const NO_FILTERS: IssueFilters = {};

/** Filters as the cache key of what they ask for: ones that ask the same give the same key. */
export const filtersKey = (filters: IssueFilters): string => {
  const search = filters.search?.trim() ?? "";
  const milestone = filters.milestone?.trim() ?? "";
  const labels = [...new Set(filters.labels ?? [])].toSorted();
  return JSON.stringify({
    ...(filters.state === undefined || filters.state === "open" ? {} : { state: filters.state }),
    ...(filters.assignedToMe === true ? { assignedToMe: true } : {}),
    ...(filters.createdByMe === true ? { createdByMe: true } : {}),
    ...(filters.mentioningMe === true ? { mentioningMe: true } : {}),
    ...(labels.length === 0 ? {} : { labels }),
    ...(milestone === "" ? (filters.noMilestone === true ? { noMilestone: true } : {}) : { milestone }),
    ...(search === "" ? {} : { search }),
  });
};

/** The filters a key stands for. */
export const filtersOfKey = (key: string): IssueFilters => JSON.parse(key) as IssueFilters;

/** How many things narrow the list besides showing the open issues, for the badge on the filter button. */
export const filterCount = (filters: IssueFilters): number =>
  (filters.state === undefined || filters.state === "open" ? 0 : 1) +
  (filters.assignedToMe === true ? 1 : 0) +
  (filters.createdByMe === true ? 1 : 0) +
  (filters.mentioningMe === true ? 1 : 0) +
  new Set(filters.labels ?? []).size +
  ((filters.milestone?.trim() ?? "") !== "" || filters.noMilestone === true ? 1 : 0);

/** Whether the list is narrowed in any way a user could clear, search included. */
export const isFiltered = (filters: IssueFilters): boolean =>
  filterCount(filters) > 0 || (filters.search?.trim() ?? "") !== "";

/** `filters` with the label added, or taken off when it is there. */
export const toggleLabel = (filters: IssueFilters, name: string): IssueFilters => {
  const labels = filters.labels ?? [];
  const next = labels.includes(name) ? labels.filter((each) => each !== name) : [...labels, name];
  const { labels: _, ...rest } = filters;
  return next.length === 0 ? rest : { ...rest, labels: next };
};

/** `filters` with a milestone chosen by its title, "none" for issues in none, or undefined to clear it. */
export const withMilestone = (filters: IssueFilters, choice: string | undefined): IssueFilters => {
  const { milestone: _a, noMilestone: _b, ...rest } = filters;
  if (choice === undefined) return rest;
  return choice === "none" ? { ...rest, noMilestone: true } : { ...rest, milestone: choice };
};

// ---------------------------------------------------------------------------------------------
// Staying current

/** How often (in milliseconds) an open issue asks, reads in full, and waits after GitHub's limit is spent. */
export const FRESHNESS = {
  /** Between questions whether the issue changed. */
  ask: 40_000,
  /** The shortest time away after which the window's return asks at once. */
  askAfter: 20_000,
  /** Between full readings, which catch edits and reactions the question can't see. */
  read: 5 * 60_000,
  /** How long to leave GitHub alone once it says the limit is spent. */
  pause: 5 * 60_000,
} as const;

/** How long (in milliseconds) GitHub's search takes to show a change made a moment ago. */
export const SEARCH_LAG = 4_000;

// ---------------------------------------------------------------------------------------------
// States

/** An issue's state in words: open, or how it was closed. */
export const stateLabel = (issue: Pick<IssueSummary, "state" | "stateReason">): string => {
  if (issue.state === "open") return "Open";
  switch (issue.stateReason) {
    case "notPlanned":
      return "Closed as not planned";
    case "duplicate":
      return "Closed as duplicate";
    default:
      return "Closed";
  }
};

/** Whether the account may change an issue's labels and assignees, which GitHub grants from triage up. */
export const canTriage = (permission: RepositoryPermission | undefined): boolean =>
  permission === "triage" || permission === "write" || permission === "maintain" || permission === "admin";

// ---------------------------------------------------------------------------------------------
// Starting a thread

/** The most of an issue's text the brief holds, so an issue with a long history still starts a thread. */
const BRIEF_LIMIT = 24_000;

/** One text's share of the brief. */
const BODY_LIMIT = 4_000;

const shorten = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit).trimEnd()}\n… (cut: ${text.length - limit} more characters on GitHub)`;

/**
 * What a thread that looks into an issue starts from: where it is, what it says and what was said
 * about it, with the ask. Comments come in order until the brief is full.
 */
export const issueBrief = (issue: IssueDetail): string => {
  const facts = [
    stateLabel(issue),
    issue.labels.length === 0 ? undefined : `labels: ${issue.labels.map((label) => label.name).join(", ")}`,
    issue.assignees.length === 0
      ? undefined
      : `assigned to ${issue.assignees.map((user) => user.login).join(", ")}`,
    issue.milestone === undefined ? undefined : `milestone: ${issue.milestone}`,
    issue.pullRequests.length === 0
      ? undefined
      : `linked pull requests: ${issue.pullRequests.map((pull) => `#${pull.number} (${pull.state})`).join(", ")}`,
  ].filter((fact) => fact !== undefined);
  const parts = [
    `Look into GitHub issue #${issue.number}, "${issue.title}" (${issue.url}).`,
    `${facts.join("; ")}${issue.author === undefined ? "" : `. Opened by ${issue.author.login}`}.`,
    issue.body.trim() === ""
      ? "It has no description."
      : `Description:\n${shorten(issue.body.trim(), BODY_LIMIT)}`,
  ];
  let size = parts.join("\n\n").length;
  const comments: Array<string> = [];
  let skipped = 0;
  for (const item of issue.timeline) {
    if (item._tag !== "Comment" || item.hidden !== undefined || item.body.trim() === "") continue;
    const entry = `${item.author?.login ?? "ghost"} wrote:\n${shorten(item.body.trim(), BODY_LIMIT)}`;
    if (size + entry.length > BRIEF_LIMIT) {
      skipped++;
      continue;
    }
    size += entry.length;
    comments.push(entry);
  }
  if (comments.length > 0) parts.push(`Comments, oldest first:\n\n${comments.join("\n\n")}`);
  if (skipped > 0 || issue.more === true)
    parts.push("More of the conversation is on GitHub than is quoted here.");
  parts.push(
    "Find the code this concerns, work out what is going on and what a fix would involve, and tell me. Don't change anything yet.",
  );
  return parts.join("\n\n");
};
