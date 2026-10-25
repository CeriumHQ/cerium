import { Atom } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

// The files an agent's turn changed, as the summary under its response opens them: one file's diff
// between the folder's snapshots from before and after the turn, and putting the turn's files back.

/** The `RPC_VERSION` that brought `TurnDiffFile` and `RevertTurnFiles`; an older machine's turns list no files. */
export const TURN_FILES_VERSION = 19;

/** A turn's file, keyed `root`, the snapshots before and after it, the path and the lines of context. */
export const turnDiffKey = (root: string, before: string, after: string, path: string, context: number) =>
  [root, before, after, path, String(context)].join("\n");

/** Snapshots never change, so a file's diff is read once while it is shown. */
export const turnDiffAtom = Atom.family((id: string) => {
  const [root = "", before = "", after = "", path = "", context = "3"] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) =>
        client("TurnDiffFile", { root, before, after, path, context: Number(context) }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

export const revertTurnFiles = Backend.mutation("RevertTurnFiles");
