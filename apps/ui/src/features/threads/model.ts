import { MAX_THREAD_TITLE, type ProviderId } from "@cerium/protocol";

/** What the sidebar shows for a thread, derived from the thread and its agents. */
export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly mode: "work" | "chat";
  /** The folder's name for work threads. */
  readonly project?: string;
  /** The folder's full path for work threads: the project's, for one in a worktree. */
  readonly folder?: string;
  /** The thread's own worktree's branch, and the branch it was made from. */
  readonly worktree?: { readonly branch: string; readonly base: string };
  readonly status: "running" | "awaitingApproval" | "idle" | "failed";
  /** Providers of the agents in the thread, lead first. */
  readonly providers: ReadonlyArray<ProviderId>;
  /** Changed since the user last had it open. Work threads only. */
  readonly unread: boolean;
  /** When it started; unknown for a summary not built from the thread's record. */
  readonly createdAt?: number;
  readonly updatedAt: number;
  /** When the user archived it. */
  readonly archivedAt?: number;
  /** When a thread the user put off comes back to the inbox. */
  readonly laterUntil?: number;
  /** The computer the thread lives on, when it isn't this one. */
  readonly machine?: string;
  /**
   * Set when the thread lives on another machine than the one the window drives: what's known of it
   * comes from the cloud copy, and acting on it means going to that machine.
   */
  readonly elsewhere?: { readonly machine: string; readonly online: boolean };
  /** The lead agent and the model it runs: what tells apart the threads of a multi-agent run. */
  readonly lead?: { readonly id: string; readonly model: string };
  /** Shared by the threads one message started with several models (multi agent). */
  readonly runId?: string;
}

/** What a list shows: a thread on its own, or the threads of one multi-agent run in one card. */
export type InboxEntry =
  | { readonly kind: "thread"; readonly thread: ThreadSummary }
  | { readonly kind: "run"; readonly id: string; readonly threads: ReadonlyArray<ThreadSummary> };

/**
 * A list's threads as it shows them: each run's threads together where the first of them is, in the
 * order they were started, and a run with one thread left in the list as that thread alone.
 */
export const groupRuns = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<InboxEntry> => {
  const runs = Map.groupBy(
    threads.filter((thread) => thread.runId !== undefined),
    (thread) => thread.runId!,
  );
  const placed = new Set<string>();
  return threads.flatMap((thread): ReadonlyArray<InboxEntry> => {
    const run = thread.runId === undefined ? undefined : runs.get(thread.runId);
    if (run === undefined || run.length < 2) return [{ kind: "thread", thread }];
    if (placed.has(thread.runId!)) return [];
    placed.add(thread.runId!);
    const started = [...run].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return [{ kind: "run", id: thread.runId!, threads: started }];
  });
};

/** An entry's threads. */
export const entryThreads = (entry: InboxEntry): ReadonlyArray<ThreadSummary> =>
  entry.kind === "thread" ? [entry.thread] : entry.threads;

const statusRank = { awaitingApproval: 3, running: 2, failed: 1, idle: 0 } as const;

/**
 * A run as one thread for what the card shows of it: the status that asks most of the user, unread
 * when any of its threads is, its latest activity, and each thread's harness, in the order started.
 */
export const runSummary = (threads: ReadonlyArray<ThreadSummary>): ThreadSummary => {
  const [first, ...rest] = threads as readonly [ThreadSummary, ...Array<ThreadSummary>];
  return {
    ...first,
    status: rest.reduce(
      (status, thread) => (statusRank[thread.status] > statusRank[status] ? thread.status : status),
      first.status,
    ),
    unread: threads.some((thread) => thread.unread),
    providers: threads.flatMap((thread) => thread.providers.slice(0, 1)),
    updatedAt: Math.max(...threads.map((thread) => thread.updatedAt)),
  };
};

/** Archived threads leave the sidebar, except while they wait on the user: a request is never out of sight. */
export const isListed = (thread: ThreadSummary): boolean =>
  thread.archivedAt === undefined || thread.status === "awaitingApproval";

/** The `RPC_VERSION` that brought `SetThreadLater`; an older machine's threads can't be put off. */
export const LATER_VERSION = 24;

/** Waiting on the user: an approval, or a failure they haven't seen. */
export const needsYou = (thread: ThreadSummary): boolean =>
  thread.status === "awaitingApproval" || (thread.status === "failed" && thread.unread);

/** Put off and not due back yet; one that needs the user comes back early. */
export const isPutOff = (thread: ThreadSummary, now: number): boolean =>
  thread.archivedAt === undefined &&
  thread.laterUntil !== undefined &&
  thread.laterUntil > now &&
  !needsYou(thread);

/** Which of the sidebar's lists shows: what's live, what's not sent yet, what's put off, what's put away. */
export type InboxBox = "inbox" | "drafts" | "later" | "archive";

/** The list a work thread is in; a thread the list doesn't know yet starts in the inbox. */
export const boxOf = (thread: ThreadSummary | undefined, now: number): InboxBox => {
  if (thread !== undefined && !isListed(thread)) return "archive";
  if (thread !== undefined && isPutOff(thread, now)) return "later";
  return "inbox";
};

/** When a thread last came to the user's attention: its latest activity, or its return from Later. */
export const inboxAt = (thread: ThreadSummary, now: number): number =>
  thread.laterUntil !== undefined && thread.laterUntil <= now
    ? Math.max(thread.updatedAt, thread.laterUntil)
    : thread.updatedAt;

/** When "Later" brings a thread back: tomorrow morning. */
export const laterTime = (now: number): number => {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.setHours(8, 0, 0, 0);
};

const DAY = 86_400_000;

/** When a thread put off comes back, as a list says it: "8:00", "Tomorrow", "Mon", "12 Oct". */
export const backLabel = (until: number, now: number): string => {
  const days = Math.round((new Date(until).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  const date = new Date(until);
  if (days <= 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Tomorrow";
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "short" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** A thread whose agents are working or waiting on the user stays where the user looks. */
export const canArchive = (thread: ThreadSummary): boolean =>
  thread.status !== "running" && thread.status !== "awaitingApproval";

/** Deleting is refused on the same grounds as archiving. */
export const canDelete = canArchive;

/** The title a rename saves: trimmed and cut to fit; none when it's empty or unchanged. */
export const renamedTitle = (current: string, typed: string): string | undefined => {
  const title = typed.trim().slice(0, MAX_THREAD_TITLE).trim();
  return title === "" || title === current ? undefined : title;
};

/** Archived threads, the most recently archived first. */
export const archivedThreads = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<ThreadSummary> =>
  threads
    .filter((thread) => thread.archivedAt !== undefined)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

/** The work threads the sidebar's Archive lists: hidden from the inbox, the most recently archived first. */
export const archivedWork = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<ThreadSummary> =>
  archivedThreads(threads.filter((thread) => thread.mode === "work" && !isListed(thread)));

/** The work threads put off for later, the soonest back first. */
export const laterWork = (threads: ReadonlyArray<ThreadSummary>, now: number): ReadonlyArray<ThreadSummary> =>
  threads
    .filter((thread) => thread.mode === "work" && isPutOff(thread, now))
    .sort((a, b) => (a.laterUntil ?? 0) - (b.laterUntil ?? 0));

/** Most threads the inbox holds before it archives the oldest quiet ones. */
export const INBOX_CAP = 8;

/**
 * What the inbox lets go when it holds more than `cap` cards, a multi-agent run counting as one: the
 * oldest that are finished and read, and that the user doesn't keep (pinned or open). One in a
 * worktree is left alone, since archiving removes its worktree, and so is one on another machine,
 * which is archived there. A run goes only as a whole.
 */
export const overflow = (
  inbox: ReadonlyArray<ThreadSummary>,
  keep: (thread: ThreadSummary) => boolean,
  now: number,
  cap = INBOX_CAP,
): ReadonlyArray<ThreadSummary> => {
  const entries = groupRuns(inbox);
  const excess = entries.length - cap;
  if (excess <= 0) return [];
  const quiet = (thread: ThreadSummary) =>
    thread.status === "idle" &&
    !thread.unread &&
    thread.worktree === undefined &&
    thread.elsewhere === undefined &&
    !keep(thread);
  const latest = (entry: InboxEntry) =>
    Math.max(...entryThreads(entry).map((thread) => inboxAt(thread, now)));
  return entries
    .filter((entry) => entryThreads(entry).every(quiet))
    .sort((a, b) => latest(a) - latest(b))
    .slice(0, excess)
    .flatMap(entryThreads);
};

export const providerName: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  muse: "Muse",
  cursor: "Cursor",
  opencode: "OpenCode",
};
