import { MAX_THREAD_TITLE, type ProviderId } from "@cerium/protocol";

/** What the sidebar shows for a thread, derived from the thread and its agents. */
export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly mode: "work" | "chat";
  /** The folder's name for work threads. */
  readonly project?: string;
  /** The folder's full path for work threads. */
  readonly folder?: string;
  readonly status: "running" | "awaitingApproval" | "idle" | "failed";
  /** Providers of the agents in the thread, lead first. */
  readonly providers: ReadonlyArray<ProviderId>;
  /** Changed since the user last had it open. Work threads only. */
  readonly unread: boolean;
  readonly updatedAt: number;
  /** When the user archived it. */
  readonly archivedAt?: number;
}

/** Archived threads leave the sidebar, except while they wait on the user: a request is never out of sight. */
export const isListed = (thread: ThreadSummary): boolean =>
  thread.archivedAt === undefined || thread.status === "awaitingApproval";

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

/** The work threads the sidebar's archived section lists: hidden from the inbox, latest activity first. */
export const archivedWork = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<ThreadSummary> =>
  threads
    .filter((thread) => thread.mode === "work" && !isListed(thread))
    .sort((a, b) => b.updatedAt - a.updatedAt);

export const providerName: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  muse: "Muse",
  cursor: "Cursor",
};
