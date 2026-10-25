import { Atom, type AtomRegistry } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

// Source control's reads and changes of a repository's branches, its sync with the remote, its stash
// and the merge in progress. Each read is an atom keyed by the folder it asks about (a thread's), and
// each starts over when its version counts up: what the machine says changed, or a change made from
// the panel, bumps it.

const versionAtoms = Atom.family((_key: string) => Atom.make(0));

/** Where `root`'s repository stands: its branch, upstream, unfinished operation and conflicts. */
export const branchStateAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(versionAtoms(`state\n${root}`));
      return Backend.use((client) => client("GitBranchState", { root }));
    })
    .pipe(Atom.setIdleTTL("2 minutes")),
);

/** The branches of `root`'s repository, read when the branch menu opens and after it changes them. */
export const branchListAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(versionAtoms(`branches\n${root}`));
      return Backend.use((client) => client("GitBranches", { root }));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

/** The stashes of `root`'s repository. */
export const stashListAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(versionAtoms(`stashes\n${root}`));
      return Backend.use((client) => client("GitStashes", { root }));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

/** What the controls last told the user about `root`: a failure, news, or a stop on conflicts. */
export interface BranchMessage {
  readonly tone: "error" | "info" | "attention";
  readonly text: string;
}

/** The change the controls of `root` are making now, by name, so one runs at a time. */
export const branchBusyAtom = Atom.family((_root: string) =>
  Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive),
);

export const branchMessageAtom = Atom.family((_root: string) =>
  Atom.make<BranchMessage | undefined>(undefined).pipe(Atom.keepAlive),
);

/** When `root`'s repository was last fetched from this window, in milliseconds since 1970. */
export const fetchedAtAtom = Atom.family((_root: string) =>
  Atom.make<number | undefined>(undefined).pipe(Atom.keepAlive),
);

const bump = (registry: AtomRegistry.AtomRegistry, id: string) =>
  registry.update(versionAtoms(id), (count) => count + 1);

/** Reads again what the machine said changed in the repository: where it stands, its branches and its stashes. */
export const refreshBranches = (registry: AtomRegistry.AtomRegistry, root: string) => {
  bump(registry, `state\n${root}`);
  bump(registry, `branches\n${root}`);
  bump(registry, `stashes\n${root}`);
};

export const gitSwitch = Backend.mutation("GitSwitch");
export const gitCreateBranch = Backend.mutation("GitCreateBranch");
export const gitRenameBranch = Backend.mutation("GitRenameBranch");
export const gitDeleteBranch = Backend.mutation("GitDeleteBranch");
export const gitSetUpstream = Backend.mutation("GitSetUpstream");
export const gitFetch = Backend.mutation("GitFetch");
/** The panel's background fetch, which a fetch the user asks for mustn't interrupt, nor it theirs. */
export const gitQuietFetch = Backend.mutation("GitFetch");
export const gitPull = Backend.mutation("GitPull");
export const gitPush = Backend.mutation("GitPush");
export const gitStash = Backend.mutation("GitStash");
export const gitStashApply = Backend.mutation("GitStashApply");
export const gitStashDrop = Backend.mutation("GitStashDrop");
export const gitMerge = Backend.mutation("GitMerge");
export const gitOperation = Backend.mutation("GitOperation");
export const gitResolve = Backend.mutation("GitResolve");
