import type { GitSide } from "@cerium/rpc";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";
import { refreshHistory } from "./history.ts";

// Source control's reads of the driven machine's repositories. Each is an atom keyed by the folder it
// asks about (a thread's, or the repository's top), and each starts over when its version counts up:
// what the machine says changed, or a change made from the panel, bumps it.

const versionAtoms = Atom.family((_key: string) => Atom.make(0));

/** What's staged, what isn't and what's conflicted in the repository `root` is in. */
export const gitStatusAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(`status\n${root}`));
      return Backend.use((client) => client("GitStatus", { root }));
    })
    .pipe(Atom.setIdleTTL("2 minutes")),
);

/** Reads `root`'s repository's status again, and its history: a status change can be a commit or a moved branch. */
export const refreshGitStatus = (registry: AtomRegistry.AtomRegistry, root: string) => {
  registry.update(versionAtoms(`status\n${root}`), (count) => count + 1);
  registry.update(versionAtoms(`diffs\n${root}`), (count) => count + 1);
  refreshHistory(registry, root);
};

/** Reads the diffs of `root`'s files again, as one of them changed but git's view of the rest didn't. */
export const refreshGitDiffs = (registry: AtomRegistry.AtomRegistry, root: string) =>
  registry.update(versionAtoms(`diffs\n${root}`), (count) => count + 1);

/** What `gitDiffAtom` is asked: one side of a file of the repository at `root`, from its top. */
export interface GitDiffRequest {
  readonly root: string;
  readonly path: string;
  readonly side: GitSide;
  readonly from?: string | undefined;
  readonly context: number;
}

export const gitDiffKey = ({ root, path, side, from, context }: GitDiffRequest) =>
  [root, path, side, from ?? "", String(context)].join("\n");

/** One side of a changed file: what's staged against the last commit, or what isn't against that. */
export const gitDiffAtom = Atom.family((key: string) => {
  const [root = "", path = "", side = "unstaged", from = "", context = "3"] = key.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(`diffs\n${root}`));
      return Backend.use((client) =>
        client("GitDiff", {
          root,
          path,
          side: side === "staged" ? "staged" : "unstaged",
          ...(from === "" ? {} : { from }),
          context: Number(context),
        }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** The last commit's message, read as the user starts to amend it. */
export const lastCommitMessage = Backend.mutation("LastCommitMessage");
export const stageFiles = Backend.mutation("StageFiles");
export const unstageFiles = Backend.mutation("UnstageFiles");
export const discardFiles = Backend.mutation("DiscardFiles");
export const applyLines = Backend.mutation("ApplyLines");
export const commitChanges = Backend.mutation("Commit");
/** A commit message a quick model wrote for what the next commit takes. */
export const draftCommitMessage = Backend.mutation("DraftCommitMessage");
