import type { ThreadSummary } from "./model.ts";

export interface ThreadSection {
  readonly key: string;
  readonly label: string;
  /** Status sections ask for something and show how many they hold; time sections are history. */
  readonly kind: "status" | "time";
  readonly threads: ReadonlyArray<ThreadSummary>;
}

const DAY = 86_400_000;

/** Which stretch of the past a moment falls in, for lists that group by how recent things are. */
export const recency = (updatedAt: number, now: number): string => {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "Today";
  if (updatedAt >= startOfToday - DAY) return "Yesterday";
  if (updatedAt >= startOfToday - 6 * DAY) return "Previous 7 days";
  return "Older";
};

const newestFirst = (threads: ReadonlyArray<ThreadSummary>) =>
  [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

const statusSections = [
  { key: "needsYou", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "unread", label: "Unread" },
] as const;

/**
 * Where a work thread sits in the inbox: waiting on the user (an approval, or a failure they haven't
 * seen), agents still working, finished since the user last looked, or history.
 */
const inboxKey = (thread: ThreadSummary, now: number): string => {
  if (thread.status === "awaitingApproval" || (thread.status === "failed" && thread.unread)) {
    return "needsYou";
  }
  if (thread.status === "running") return "working";
  if (thread.unread) return "unread";
  return recency(thread.updatedAt, now);
};

/** Work threads across every project, ordered by what needs the user first; newest first within each. */
export const inboxSections = (
  threads: ReadonlyArray<ThreadSummary>,
  now = Date.now(),
): ReadonlyArray<ThreadSection> => {
  const byKey = new Map<string, Array<ThreadSummary>>();
  for (const thread of newestFirst(threads)) {
    const key = inboxKey(thread, now);
    byKey.set(key, [...(byKey.get(key) ?? []), thread]);
  }
  return [
    ...statusSections.map(({ key, label }) => ({ key, label, kind: "status" as const })),
    ...["Today", "Yesterday", "Previous 7 days", "Older"].map((label) => ({
      key: label,
      label,
      kind: "time" as const,
    })),
  ].flatMap((section) => {
    const sectionThreads = byKey.get(section.key);
    return sectionThreads ? [{ ...section, threads: sectionThreads }] : [];
  });
};

/** Chats have no folder, so they group by how recent they are; newest first within each group. */
export const chatSections = (
  threads: ReadonlyArray<ThreadSummary>,
  now = Date.now(),
): ReadonlyArray<ThreadSection> => {
  const byLabel = new Map<string, ThreadSection>();
  for (const thread of newestFirst(threads)) {
    const label = recency(thread.updatedAt, now);
    const section = byLabel.get(label) ?? { key: label, label, kind: "time", threads: [] };
    byLabel.set(label, { ...section, threads: [...section.threads, thread] });
  }
  return [...byLabel.values()];
};

export interface InboxProject {
  readonly folder: string;
  readonly name: string;
}

/** The folders work threads ran in, most recently active first, for scoping the inbox to one. */
export const inboxProjects = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<InboxProject> => {
  const byFolder = new Map<string, InboxProject>();
  for (const thread of newestFirst(threads)) {
    if (thread.folder !== undefined && thread.project !== undefined && !byFolder.has(thread.folder)) {
      byFolder.set(thread.folder, { folder: thread.folder, name: thread.project });
    }
  }
  return [...byFolder.values()];
};
