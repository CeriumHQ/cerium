import { RECENT_SESSION_DAYS, type PastSession, type ProviderId } from "@cerium/protocol";

// Picking which of the user's own harness sessions come in as threads: grouped by the folder each ran
// in, with the recent ones ticked. The welcome and the command palette's dialog share it.

const DAY = 86_400_000;

/** How many sessions are ticked at most to begin with, so a first import doesn't flood the inbox. */
export const DEFAULT_PICKS = 30;

/** A session's key among every harness's: two harnesses may use the same id. */
export const sessionKey = (session: Pick<PastSession, "provider" | "id">): string =>
  `${session.provider}:${session.id}`;

/** Sessions last active before this go to Archive as they come in. */
export const recentSince = (now: number): number => now - RECENT_SESSION_DAYS * DAY;

/** The sessions of one folder, or those with none, which come in as chats. */
export interface ProjectGroup {
  readonly key: string;
  /** The folder; absent for sessions without one. */
  readonly cwd?: string;
  /** The folder's own name, or "Chats". */
  readonly name: string;
  /** Newest first. */
  readonly sessions: ReadonlyArray<PastSession>;
  /** How many were active within `RECENT_SESSION_DAYS`. */
  readonly recent: number;
  /** The harnesses they ran on, in the order first met. */
  readonly providers: ReadonlyArray<ProviderId>;
}

/** The last segment of a folder's path, either separator. */
export const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;

/** A folder compared as Windows does, whatever its case and separators. */
const folderKey = (path: string): string =>
  /^[a-z]:[\\/]/i.test(path) ? path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : path;

/** Sessions by folder, the most recently active folder first; chats last. */
export const groupByProject = (
  sessions: ReadonlyArray<PastSession>,
  now: number,
): ReadonlyArray<ProjectGroup> => {
  const since = recentSince(now);
  const groups = new Map<string, Array<PastSession>>();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = session.cwd === undefined ? "" : folderKey(session.cwd);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [session]);
    else group.push(session);
  }
  const projects = [...groups].map(([key, members]): ProjectGroup => {
    const cwd = members[0]!.cwd;
    return {
      key,
      ...(cwd === undefined ? {} : { cwd }),
      name: cwd === undefined ? "Chats" : folderName(cwd),
      sessions: members,
      recent: members.filter((session) => session.updatedAt >= since).length,
      providers: [...new Set(members.map((session) => session.provider))],
    };
  });
  return [
    ...projects.filter((group) => group.cwd !== undefined),
    ...projects.filter((group) => group.cwd === undefined),
  ];
};

/** The sessions ticked to begin with: the newest active within `RECENT_SESSION_DAYS`, `DEFAULT_PICKS` at most. */
export const defaultPicks = (sessions: ReadonlyArray<PastSession>, now: number): ReadonlySet<string> => {
  const since = recentSince(now);
  return new Set(
    [...sessions]
      .filter((session) => session.updatedAt >= since)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, DEFAULT_PICKS)
      .map(sessionKey),
  );
};

/** How much of a group is ticked: a checkbox's three states. */
export const groupPicked = (group: ProjectGroup, picked: ReadonlySet<string>): "all" | "some" | "none" => {
  const count = group.sessions.filter((session) => picked.has(sessionKey(session))).length;
  return count === 0 ? "none" : count === group.sessions.length ? "all" : "some";
};

/** Ticks every session of a group, or clears them all when every one is ticked already. */
export const toggleGroup = (group: ProjectGroup, picked: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set(picked);
  const all = groupPicked(group, picked) === "all";
  for (const session of group.sessions) {
    if (all) next.delete(sessionKey(session));
    else next.add(sessionKey(session));
  }
  return next;
};

export const toggleSession = (session: PastSession, picked: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set(picked);
  const key = sessionKey(session);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};
