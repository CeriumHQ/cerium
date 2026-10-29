import { portable, unfilled, type HarnessHub } from "@cerium/harness";
import { Adapters } from "@cerium/orchestrator";
import type {
  HubCopyOutcome,
  HubHarness,
  HubScope,
  HubServer,
  HubSkill,
  HubSupport,
  ProviderId,
} from "@cerium/protocol";
import { CeriumError, HubRpcs, type HubCopyTarget } from "@cerium/rpc";
import { Effect, FileSystem, Path } from "effect";

import { harnessName } from "./discord.ts";

// The MCP and skills hub's requests, answered by each adapter's own `hub`: Cerium reads and edits a
// harness's config only through it, and copies between harnesses translate through `PortableServer`,
// which carries a server's shape and the names of its secrets, never their values.

/** How long a harness may take to list its config, and to report its servers' state. */
const READ_TIMEOUT = "30 seconds";
const STATUS_TIMEOUT = "90 seconds";
/** How long a harness may take to say whether it's installed. */
const PROBE_TIMEOUT = "15 seconds";

const NO_SUPPORT: HubSupport = { servers: "none", tools: "none", skills: "none", status: false };

const refuse = (error: { readonly message: string }) => new CeriumError({ message: error.message });

const timedOut = (what: string) => () => Effect.fail(new CeriumError({ message: `${what} took too long.` }));

/** Folders compared as the file system does: on Windows, in any case and either slash. */
const sameFolder = (a: string, b: string) => {
  const norm = (folder: string) => {
    const forward = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? forward.toLowerCase() : forward;
  };
  return norm(a) === norm(b);
};

export const hubHandlers = Effect.gen(function* () {
  const adapters = yield* Adapters;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hubOf = (provider: ProviderId) =>
    Effect.gen(function* () {
      const hub = adapters.get(provider)?.hub;
      if (hub === undefined) {
        return yield* new CeriumError({ message: `Cerium can't read ${harnessName[provider]}'s config.` });
      }
      return hub;
    });

  const listingOf = (hub: HarnessHub, provider: ProviderId, project: string) =>
    hub.read(project).pipe(
      Effect.mapError(refuse),
      Effect.timeoutOrElse({
        duration: READ_TIMEOUT,
        orElse: timedOut(`Reading ${harnessName[provider]}'s config`),
      }),
    );

  const findServer = (provider: ProviderId, project: string, name: string, scope: HubScope) =>
    Effect.gen(function* () {
      const hub = yield* hubOf(provider);
      const { servers } = yield* listingOf(hub, provider, project);
      const server = servers.find((each) => each.name === name && each.scope === scope);
      if (server === undefined) {
        return yield* new CeriumError({
          message: `${name} isn't in ${harnessName[provider]}'s config anymore.`,
        });
      }
      return { hub, server };
    });

  const findSkill = (provider: ProviderId, project: string, folder: string) =>
    Effect.gen(function* () {
      const hub = yield* hubOf(provider);
      const { skills } = yield* listingOf(hub, provider, project);
      const skill = skills.find((each) => sameFolder(each.path, folder));
      if (skill === undefined) {
        return yield* new CeriumError({
          message: `That skill isn't in ${harnessName[provider]}'s folders anymore.`,
        });
      }
      return { hub, skill };
    });

  /** One harness's servers and skills, or why it has none to show. */
  const readHarness = (provider: ProviderId, project: string): Effect.Effect<HubHarness> =>
    Effect.gen(function* () {
      const adapter = adapters.get(provider);
      const empty = { provider, servers: [], skills: [] };
      const installed =
        adapter === undefined
          ? false
          : yield* adapter.probe.pipe(
              Effect.map((status) => status._tag !== "HarnessMissing"),
              Effect.timeoutOrElse({ duration: PROBE_TIMEOUT, orElse: () => Effect.succeed(true) }),
              Effect.orElseSucceed(() => true),
            );
      if (!installed) return { ...empty, support: NO_SUPPORT, unavailable: "Not installed." };
      const hub = adapter?.hub;
      if (hub === undefined) {
        return {
          ...empty,
          support: NO_SUPPORT,
          unavailable: `${harnessName[provider]} shares its MCP servers and skills only inside a session, so Cerium can't list them yet.`,
        };
      }
      return yield* listingOf(hub, provider, project).pipe(
        Effect.map((listing): HubHarness => ({
          provider,
          support: hub.support,
          servers: listing.servers,
          skills: listing.skills,
          ...(listing.notice ? { notice: listing.notice } : {}),
        })),
        Effect.catch((error) =>
          Effect.succeed<HubHarness>({ ...empty, support: hub.support, unavailable: error.message }),
        ),
      );
    });

  /** Runs `copy` for each target harness, saying for each where it went or why it didn't. */
  const copyTo = (
    from: ProviderId,
    targets: ReadonlyArray<HubCopyTarget>,
    copy: (
      hub: HarnessHub,
      target: HubCopyTarget,
    ) => Effect.Effect<Omit<HubCopyOutcome, "provider">, { readonly message: string }>,
  ) =>
    Effect.forEach(
      targets.filter((target) => target.provider !== from),
      (target) =>
        Effect.gen(function* () {
          const hub = adapters.get(target.provider)?.hub;
          if (hub === undefined) {
            return {
              provider: target.provider,
              fill: [],
              skipped: `Cerium can't write ${harnessName[target.provider]}'s config.`,
            };
          }
          return yield* copy(hub, target).pipe(
            Effect.map((outcome): HubCopyOutcome => ({ provider: target.provider, ...outcome })),
            Effect.catch((error) =>
              Effect.succeed<HubCopyOutcome>({ provider: target.provider, fill: [], skipped: error.message }),
            ),
          );
        }),
      { concurrency: 1 },
    );

  const copyServer = (
    project: string,
    server: HubServer,
    targets: ReadonlyArray<HubCopyTarget>,
    from: ProviderId,
  ) => {
    const shape = portable(server);
    return copyTo(from, targets, (hub, target) =>
      hub.addServer === undefined
        ? Effect.fail({ message: `Cerium can't add servers to ${harnessName[target.provider]}.` })
        : hub
            .addServer(project, target.scope, shape)
            .pipe(Effect.map((wrote) => ({ wrote, fill: unfilled(shape) }))),
    );
  };

  const copySkill = (
    project: string,
    skill: HubSkill,
    targets: ReadonlyArray<HubCopyTarget>,
    from: ProviderId,
  ) =>
    copyTo(from, targets, (hub, target) =>
      hub.skillsFolder === undefined
        ? Effect.fail({ message: `Cerium can't add skills to ${harnessName[target.provider]}.` })
        : Effect.gen(function* () {
            const folder = yield* hub.skillsFolder!(project, target.scope);
            const destination = path.join(folder, path.basename(skill.path));
            if (sameFolder(destination, skill.path)) return { fill: [], skipped: "It's already there." };
            if (yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false))) {
              return { fill: [], skipped: `${destination} already exists.` };
            }
            yield* fs.makeDirectory(folder, { recursive: true });
            yield* fs.copy(skill.path, destination);
            return { wrote: destination, fill: [] };
          }).pipe(
            Effect.mapError((error) => ({
              message: "message" in error ? String(error.message) : "Could not copy it.",
            })),
          ),
    );

  return HubRpcs.of({
    ReadHub: ({ project }) =>
      Effect.forEach([...adapters.keys()], (provider) => readHarness(provider, project), {
        concurrency: "unbounded",
      }),
    ReadHubStatus: ({ provider, project }) =>
      Effect.gen(function* () {
        const hub = yield* hubOf(provider);
        if (hub.status === undefined) return [];
        return yield* hub.status(project).pipe(
          Effect.mapError(refuse),
          Effect.timeoutOrElse({
            duration: STATUS_TIMEOUT,
            orElse: timedOut(`Asking ${harnessName[provider]} about its servers`),
          }),
        );
      }),
    SetHubServer: ({ provider, project, name, scope, enabled }) =>
      Effect.gen(function* () {
        const { hub, server } = yield* findServer(provider, project, name, scope);
        if (hub.setServer === undefined) {
          return yield* new CeriumError({
            message: `${harnessName[provider]} has no switch for a server in a project.`,
          });
        }
        yield* hub.setServer(project, server, enabled).pipe(Effect.mapError(refuse));
      }),
    SetHubTool: ({ provider, project, name, scope, tool, enabled }) =>
      Effect.gen(function* () {
        const { hub, server } = yield* findServer(provider, project, name, scope);
        if (hub.setTool === undefined) {
          return yield* new CeriumError({
            message: `${harnessName[provider]} has no switch for a single tool.`,
          });
        }
        yield* hub.setTool(project, server, tool, enabled).pipe(Effect.mapError(refuse));
      }),
    SetHubSkill: ({ provider, project, path: folder, enabled }) =>
      Effect.gen(function* () {
        const { hub, skill } = yield* findSkill(provider, project, folder);
        if (hub.setSkill === undefined) {
          return yield* new CeriumError({ message: `${harnessName[provider]} has no switch for a skill.` });
        }
        yield* hub.setSkill(project, skill, enabled).pipe(Effect.mapError(refuse));
      }),
    CopyHubServer: ({ provider, project, name, scope, to }) =>
      Effect.flatMap(findServer(provider, project, name, scope), ({ server }) =>
        copyServer(project, server, to, provider),
      ),
    CopyHubSkill: ({ provider, project, path: folder, to }) =>
      Effect.flatMap(findSkill(provider, project, folder), ({ skill }) =>
        copySkill(project, skill, to, provider),
      ),
  });
});
