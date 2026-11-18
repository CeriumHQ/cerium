import type { ThreadId } from "@cerium/protocol";
import { Atom, type AtomRegistry } from "effect/reactivity";
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
const workspaceRequestAtom = Atom.family((_threadId: ThreadId) =>
  Atom.make<{ readonly epoch: number; readonly refreshCheckout: boolean } | undefined>(undefined),
);

export const workspaceAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime
    .atom((get) => {
      const epoch = get(connectionEpochAtom);
      const request = get(workspaceRequestAtom(threadId));
      const refreshCheckout = request?.epoch === epoch ? request.refreshCheckout : true;
      return Backend.use((client) =>
        client("SourceControl", { threadId, command: { action: "status" }, refreshCheckout }),
      );
    })
    .pipe(Atom.setIdleTTL(0)),
);

export const refreshWorkspace = (
  registry: AtomRegistry.AtomRegistry,
  threadId: ThreadId,
  refreshCheckout = true,
) =>
  registry.set(workspaceRequestAtom(threadId), { epoch: registry.get(connectionEpochAtom), refreshCheckout });
