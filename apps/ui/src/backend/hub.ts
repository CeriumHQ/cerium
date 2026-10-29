import type { ProviderId } from "@cerium/protocol";
import { Atom } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

// The MCP and skills hub (Settings → MCP & skills): each harness's servers and skills for a project,
// as its own config has them, and their live status, which is slower to get, read per harness once
// the list shows.

/** Each harness's servers and skills for a project, keyed by its folder. */
export const hubAtom = Atom.family((project: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) => client("ReadHub", { project }));
    })
    .pipe(Atom.setIdleTTL("5 minutes")),
);

/** A harness's servers as it reports them right now, keyed by `provider` and project. */
export const hubStatusAtom = Atom.family((key: `${ProviderId}\u0000${string}`) => {
  const [provider, project] = key.split("\u0000") as [ProviderId, string];
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) => client("ReadHubStatus", { provider, project }));
    })
    .pipe(Atom.setIdleTTL("2 minutes"));
});

/** The key `hubStatusAtom` takes. */
export const hubStatusKey = (provider: ProviderId, project: string) => `${provider}\u0000${project}` as const;

export const setHubServer = Backend.mutation("SetHubServer");
export const setHubTool = Backend.mutation("SetHubTool");
export const setHubSkill = Backend.mutation("SetHubSkill");
export const copyHubServer = Backend.mutation("CopyHubServer");
export const copyHubSkill = Backend.mutation("CopyHubSkill");
