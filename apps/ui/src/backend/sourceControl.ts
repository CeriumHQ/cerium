import type { ThreadId } from "@cerium/protocol";
import { Atom } from "effect/reactivity";
import { Backend, connectionEpochAtom } from "./client.ts";

export const sourceControl = Backend.mutation("SourceControl");
export const relatedWorkThreadsAtom = Atom.family((url: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) => client("RelatedWorkThreads", { url }));
    })
    .pipe(Atom.setIdleTTL("30 seconds")),
);
export const workspaceAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) => client("SourceControl", { threadId, command: { action: "status" } }));
    })
    .pipe(Atom.setIdleTTL("30 seconds")),
);
