import { Atom, type AtomRegistry } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";

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

/** Reads `root`'s repository's status again. */
export const refreshGitStatus = (registry: AtomRegistry.AtomRegistry, root: string) =>
  registry.update(versionAtoms(`status\n${root}`), (count) => count + 1);
