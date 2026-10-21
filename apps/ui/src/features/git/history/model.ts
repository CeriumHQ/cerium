import type { CommitRef } from "@cerium/rpc";

// What the History tab says about a commit, as plain functions: when it was written, and what its refs
// are called in a chip.

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

/** A ref's chip text: a branch or an upstream by its name, a tag with its kind, so a tag reads as one. */
export const refLabel = (ref: CommitRef): string => (ref.kind === "tag" ? `tag ${ref.name}` : ref.name);

/** A ref's chip colour by its kind: the checked-out branch stands out, tags and upstreams stay quiet. */
export const refTone = (ref: CommitRef): string => {
  if (ref.current === true) return "border-running/40 bg-running/10 text-running";
  if (ref.kind === "tag") return "border-attention/35 bg-attention/10 text-attention";
  if (ref.kind === "upstream") return "border-line-strong text-fg-tertiary";
  return "border-line-strong text-fg-secondary";
};

/** The lines of a path, its folder dimmed and its name leading: `src/` and `app.ts`. */
export const splitPath = (path: string): { readonly folder: string; readonly name: string } => {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};
