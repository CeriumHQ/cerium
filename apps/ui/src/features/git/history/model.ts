// What the History tab says about a commit, as plain functions: when it was written, and how its paths
// read.

/** How long ago a commit was written, in the words the list uses: "now", "5m", "3h", "2d", then a date. */
export const timeAgo = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** The lines of a path, its folder dimmed and its name leading: `src/` and `app.ts`. */
export const splitPath = (path: string): { readonly folder: string; readonly name: string } => {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};
