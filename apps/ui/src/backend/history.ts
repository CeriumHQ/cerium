import { Atom, type AtomRegistry } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";

// The History tab's reads of a work thread's git history on the machine that runs it. Each read is an
// atom keyed by the folder it reads and what it asks for, so a page is read again when the folder's
// version counts up: what the machine says changed (a new commit, a moved branch) bumps it.

const key = (...parts: ReadonlyArray<string>) => parts.join("\n");

/** Counts up whenever a folder's history may have changed, so its reads start over. */
export const historyVersionAtom = Atom.family((_root: string) => Atom.make(0).pipe(Atom.keepAlive));

/** Says `root`'s history may have moved: its commits are read again. Source control calls it with each status change. */
export const refreshHistory = (registry: AtomRegistry.AtomRegistry, root: string) =>
  registry.update(historyVersionAtom(root), (count) => count + 1);

/** A page of a folder's commits, keyed `root`, the search and the offset of the page. */
export const commitPageKey = (root: string, query: string, offset: number) =>
  key(root, query, String(offset));

export const commitPageAtom = Atom.family((id: string) => {
  const [root = "", query = "", offset = "0"] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(historyVersionAtom(root));
      return Backend.use((client) =>
        client("CommitHistory", {
          root,
          offset: Number(offset),
          ...(query.trim() === "" ? {} : { query: query.trim() }),
        }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** One commit in full, keyed `root` and its SHA. */
export const commitDetailAtom = Atom.family((id: string) => {
  const [root = "", sha = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(historyVersionAtom(root));
      return Backend.use((client) => client("CommitDetail", { root, sha }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/**
 * A file a commit changed against its first parent, keyed `root`, the SHA, the path, where it was
 * before a rename and how many unchanged lines show around each change.
 */
export const commitDiffKey = (
  root: string,
  sha: string,
  path: string,
  from: string | undefined,
  context: number,
) => key(root, sha, path, from ?? "", String(context));

export const commitDiffAtom = Atom.family((id: string) => {
  const [root = "", sha = "", path = "", from = "", context = "3"] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) =>
        client("CommitDiffFile", {
          root,
          sha,
          path,
          context: Number(context),
          ...(from === "" ? {} : { from }),
        }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});
