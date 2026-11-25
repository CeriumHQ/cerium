import type { HubHarness, ProviderId } from "@cerium/protocol";
import { AsyncResult, Atom } from "effect/reactivity";

import { harnessesAtom, settingsAtom } from "./atoms.ts";
import { Backend, connectionEpochAtom } from "./client.ts";

// The MCP and skills hub (Settings → MCP & skills): each harness's servers and skills for a project,
// as its own config has them, and their live status, which is slower to get, read per harness once
// the list shows.

const disabledProvidersKeyAtom = Atom.make((get) => {
  const settings = AsyncResult.getOrElse(get(settingsAtom), () => undefined);
  return settings === undefined ? "" : [...settings.disabledProviders].sort().join(",");
});

/** Each harness's servers and skills for a project, keyed by its folder. */
export const hubAtom = Atom.family((project: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(disabledProvidersKeyAtom);
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

/** Every harness's live status for a project, from each that reports one, keyed by harness. */
export const hubStatusesAtom = Atom.family((project: string) =>
  Atom.make((get) => {
    const harnesses = AsyncResult.getOrElse(get(hubAtom(project)), (): ReadonlyArray<HubHarness> => []);
    const statuses = AsyncResult.getOrElse(get(harnessesAtom), () => undefined);
    const settings = AsyncResult.getOrElse(get(settingsAtom), () => undefined);
    if (statuses === undefined) return new Map();
    const off = new Set(settings?.disabledProviders ?? []);
    const ready = new Set(
      statuses.flatMap((status) =>
        status._tag === "HarnessInstalled" && status.auth._tag === "LoggedIn" && !off.has(status.provider)
          ? [status.provider]
          : [],
      ),
    );
    return new Map(
      harnesses
        .filter(
          (harness) =>
            harness.unavailable === undefined && harness.support.status && ready.has(harness.provider),
        )
        .map((harness) => [harness.provider, get(hubStatusAtom(hubStatusKey(harness.provider, project)))]),
    );
  }),
);

export const setHubServer = Backend.mutation("SetHubServer");
export const setHubTool = Backend.mutation("SetHubTool");
export const setHubSkill = Backend.mutation("SetHubSkill");
export const copyHubServer = Backend.mutation("CopyHubServer");
export const copyHubSkill = Backend.mutation("CopyHubSkill");

export const hubInstructionsAtom = Atom.family((key: `${string}\u0000${string}`) => {
  const project = key.slice(key.indexOf("\u0000") + 1);
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(disabledProvidersKeyAtom);
      return Backend.use((client) => client("ReadHubInstructions", { project }));
    })
    .pipe(Atom.setIdleTTL("5 minutes"));
});

export const hubInstructionsKey = (machine: string | undefined, project: string) =>
  `${machine ?? ""}\u0000${project}` as const;

export const syncHubInstructions = Backend.mutation("SyncHubInstructions");
