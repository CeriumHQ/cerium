import {
  editJsonc,
  HarnessFailure,
  HubConflict,
  isRecord,
  parseJsonc,
  readSkillFolders,
  readText,
  rewriteFile,
  secretsOf,
  type HarnessHub,
  type HarnessUnavailable,
  type HubListing,
  type PortableServer,
} from "@cerium/harness";
import type {
  HubConnection,
  HubScope,
  HubServer,
  HubServerStatus,
  HubSkill,
  HubTargetScope,
} from "@cerium/protocol";
import { Effect, FileSystem, Path, type Context } from "effect";
import { homedir } from "node:os";

import { call, type OpenCodeClient } from "./host.ts";

// OpenCode's MCP servers and skills. Its server reads them (`config.get` lists each config document
// with its file, `skill.list` the skills, `mcp.list` each server's state); Cerium edits the documents
// themselves. OpenCode turns a server or skill off for a project with a policy in the project's own
// config, `{ action: "integration.use", resource: "mcp:<name>" | "skill:<name>", effect: "deny" }`,
// the last matching rule winning. It has no switch for a server's single tools.

type Platform = FileSystem.FileSystem | Path.Path;

/** How long a change waits for OpenCode to read it back. */
const SETTLE_MS = 8_000;

/** How long a status read waits for servers that are still connecting. */
const STATUS_WAIT_MS = 12_000;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** A config document as `config.get` reports it. */
export interface ConfigDocument {
  readonly path?: string;
  readonly info: unknown;
}

interface Policy {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

const comparable = (file: string) => {
  const forward = file.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
};

const inside = (file: string, folder: string) => comparable(file).startsWith(`${comparable(folder)}/`);

/** The user's own config folder, as OpenCode resolves it. */
const userFolder = () =>
  `${process.env["XDG_CONFIG_HOME"] ?? `${homedir()}/.config`}/opencode`.replaceAll("\\", "/");

const policiesOf = (documents: ReadonlyArray<ConfigDocument>): ReadonlyArray<Policy> =>
  documents.flatMap((document) =>
    isRecord(document.info) && Array.isArray(document.info["policies"])
      ? document.info["policies"].flatMap((rule: unknown): ReadonlyArray<Policy> =>
          isRecord(rule) &&
          typeof rule["action"] === "string" &&
          typeof rule["resource"] === "string" &&
          typeof rule["effect"] === "string"
            ? [{ action: rule["action"], resource: rule["resource"], effect: rule["effect"] }]
            : [],
        )
      : [],
  );

const globMatches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(value);

/** Whether OpenCode's policies leave `resource` (`mcp:<name>`, `skill:<name>`) on: the last match wins. */
export const allowedBy = (policies: ReadonlyArray<Policy>, resource: string) =>
  policies.findLast((rule) => rule.action === "integration.use" && globMatches(rule.resource, resource))
    ?.effect !== "deny";

const serverOf = (
  name: string,
  value: unknown,
  scope: HubScope,
  file: string | undefined,
): HubServer | undefined => {
  if (!isRecord(value)) return undefined;
  const command = Array.isArray(value["command"])
    ? value["command"].filter((part): part is string => typeof part === "string")
    : [];
  const remote = value["type"] === "remote" && typeof value["url"] === "string";
  if (!remote && command.length === 0) return undefined;
  return {
    name,
    scope,
    transport: remote ? "http" : "stdio",
    ...(remote ? { url: value["url"] as string } : { command: command[0] ?? "", args: command.slice(1) }),
    env: secretsOf(value["environment"]),
    headers: secretsOf(value["headers"]),
    // v1 files say `enabled`, v2 ones `disabled`.
    enabled: value["disabled"] !== true && value["enabled"] !== false,
    disabledTools: [],
    ...(file !== undefined ? { file } : {}),
  };
};

/** Every server a document defines, in either of OpenCode's shapes. */
const serversIn = (info: unknown): ReadonlyArray<readonly [string, unknown]> => {
  const mcp = isRecord(info) && isRecord(info["mcp"]) ? info["mcp"] : {};
  if (isRecord(mcp["servers"])) return Object.entries(mcp["servers"]);
  return Object.entries(mcp).filter(([, value]) => isRecord(value) && typeof value["type"] === "string");
};

/** OpenCode's servers for a project, from its config documents, a later document's server winning. */
export const openCodeServers = (
  documents: ReadonlyArray<ConfigDocument>,
  project: string,
): ReadonlyArray<HubServer> => {
  const policies = policiesOf(documents);
  const byName = new Map<string, HubServer>();
  for (const document of documents) {
    const scope: HubScope =
      document.path === undefined
        ? "bundled"
        : inside(document.path, project)
          ? "project"
          : inside(document.path, userFolder())
            ? "user"
            : "bundled";
    for (const [name, value] of serversIn(document.info)) {
      const server = serverOf(name, value, scope, document.path);
      if (server !== undefined) byName.set(name, server);
    }
  }
  return [...byName.values()].map((server) => ({
    ...server,
    enabled: server.enabled && allowedBy(policies, `mcp:${server.name}`),
  }));
};

const connectionOf = (status: string): HubConnection => {
  switch (status) {
    case "connected":
      return "connected";
    case "pending":
      return "starting";
    case "disabled":
      return "disabled";
    case "needs_auth":
      return "needsAuth";
    default:
      return "failed";
  }
};

/** The project's own config file: the one it has, or the `opencode.json` OpenCode itself would add. */
const projectFile = (documents: ReadonlyArray<ConfigDocument>, project: string) =>
  documents.findLast((document) => document.path !== undefined && inside(document.path, project))?.path ??
  `${project}/opencode.json`;

const userFile = (documents: ReadonlyArray<ConfigDocument>) =>
  documents.find((document) => document.path !== undefined && inside(document.path, userFolder()))?.path ??
  `${userFolder()}/opencode.json`;

/** The project's policies with `resource`'s own rules replaced: a deny to turn it off, an allow to undo a wider deny. */
export const withPolicy = (
  current: unknown,
  resource: string,
  enabled: boolean,
  deniedElsewhere: boolean,
): ReadonlyArray<unknown> => {
  const kept = (Array.isArray(current) ? current : []).filter(
    (rule: unknown) =>
      !(isRecord(rule) && rule["action"] === "integration.use" && rule["resource"] === resource),
  );
  if (enabled && !deniedElsewhere) return kept;
  return [...kept, { action: "integration.use", resource, effect: enabled ? "allow" : "deny" }];
};

/** A copied server in OpenCode's shape for the file it goes in, its secrets left blank. */
export const toOpenCodeServer = (server: PortableServer): Record<string, unknown> => {
  const blank = (names: ReadonlyArray<string>) => Object.fromEntries(names.map((name) => [name, ""]));
  return server.transport === "stdio"
    ? {
        type: "local",
        command: [server.command ?? "", ...(server.args ?? [])],
        ...(server.env.length > 0 ? { environment: blank(server.env) } : {}),
      }
    : {
        type: "remote",
        url: server.url ?? "",
        ...(server.headers.length > 0 ? { headers: blank(server.headers) } : {}),
      };
};

/** Where a server goes in a file: `mcp.servers.<name>` (v2), unless the file already lists v1-style. */
const serverPath = (text: string, name: string): ReadonlyArray<string> => {
  const parsed = parseJsonc(text);
  const mcp = isRecord(parsed) && isRecord(parsed["mcp"]) ? parsed["mcp"] : undefined;
  const v1 =
    mcp !== undefined &&
    !isRecord(mcp["servers"]) &&
    Object.values(mcp).some((value) => isRecord(value) && typeof value["type"] === "string");
  return v1 ? ["mcp", name] : ["mcp", "servers", name];
};

export const makeOpenCodeHub = (
  withClient: <A, E>(
    use: (client: OpenCodeClient) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | HarnessFailure | HarnessUnavailable>,
  platform: Context.Context<Platform>,
): HarnessHub => {
  const documentsOf = (project: string) =>
    withClient((client) =>
      call("read its config", (signal) =>
        client.config.get({ location: { directory: project } }, { signal }),
      ),
    ).pipe(
      Effect.map((entries) =>
        entries.flatMap((entry): ReadonlyArray<ConfigDocument> =>
          entry.type === "document"
            ? [{ ...(entry.path ? { path: entry.path } : {}), info: entry.info }]
            : [],
        ),
      ),
    );

  /**
   * Waits, a few seconds at most, until OpenCode's server has read a change Cerium just wrote: it
   * picks up its config files a moment after they change.
   */
  const settled = (project: string, took: (documents: ReadonlyArray<ConfigDocument>) => boolean) =>
    Effect.gen(function* () {
      const deadline = Date.now() + SETTLE_MS;
      while (Date.now() < deadline && !took(yield* documentsOf(project))) yield* Effect.sleep("300 millis");
    });

  const read = (project: string) =>
    Effect.gen(function* () {
      const documents = yield* documentsOf(project);
      const policies = policiesOf(documents);
      const listed = yield* withClient((client) =>
        call("list its skills", (signal) =>
          client.skill.list({ location: { directory: project } }, { signal }),
        ),
      );
      const path = yield* Path.Path;
      const scopeOf = (file: string): HubScope =>
        inside(file, project) ? "project" : inside(file, userFolder()) ? "user" : "bundled";
      const skills: Array<HubSkill> = listed.data.map((skill) => ({
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        scope: scopeOf(skill.path),
        path: path.dirname(skill.path),
        enabled: true,
      }));
      // OpenCode leaves a denied skill out of its list: find it in the folders it reads.
      const denied = policies
        .filter(
          (rule) =>
            rule.action === "integration.use" && rule.effect === "deny" && rule.resource.startsWith("skill:"),
        )
        .map((rule) => rule.resource.slice("skill:".length));
      if (denied.some((name) => !skills.some((skill) => skill.name === name))) {
        const folders: ReadonlyArray<readonly [string, HubScope]> = [
          [path.join(project, ".opencode", "skills"), "project"],
          [path.join(project, ".agents", "skills"), "project"],
          [path.join(project, ".claude", "skills"), "project"],
          [path.join(userFolder(), "skills"), "user"],
          [path.join(homedir(), ".agents", "skills"), "user"],
          [path.join(homedir(), ".claude", "skills"), "user"],
        ];
        for (const [folder, scope] of folders) {
          for (const skill of yield* readSkillFolders(folder, scope)) {
            if (
              !allowedBy(policies, `skill:${skill.name}`) &&
              !skills.some((each) => each.name === skill.name)
            ) {
              skills.push({ ...skill, enabled: false });
            }
          }
        }
      }
      const listing: HubListing = {
        servers: openCodeServers(documents, project),
        skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      };
      return listing;
    });

  /** Switches `resource` in the project's own config, with an allow only when a wider file denies it. */
  const setPolicy = (project: string, resource: string, enabled: boolean) =>
    Effect.gen(function* () {
      const documents = yield* documentsOf(project);
      const file = projectFile(documents, project);
      const wider = policiesOf(
        documents.filter((document) => document.path !== undefined && !inside(document.path, project)),
      );
      const text = yield* readText(file);
      const parsed = parseJsonc(text);
      if (text.trim() !== "" && !isRecord(parsed)) {
        return yield* new HarnessFailure({
          provider: "opencode",
          message: `${file} isn't valid JSON`,
          cause: undefined,
        });
      }
      yield* rewriteFile(file, (current) => {
        const config = parseJsonc(current);
        const policies = withPolicy(
          isRecord(config) ? config["policies"] : undefined,
          resource,
          enabled,
          !allowedBy(wider, resource),
        );
        return editJsonc(current, ["policies"], policies.length > 0 ? policies : undefined);
      }).pipe(Effect.mapError(failure(`Could not write ${file}`)));
      yield* settled(project, (documents) => allowedBy(policiesOf(documents), resource) === enabled);
    });

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    Effect.gen(function* () {
      const documents = yield* documentsOf(project);
      if (openCodeServers(documents, project).some((each) => each.name === server.name)) {
        return yield* new HubConflict({ message: `OpenCode already has a server named ${server.name}.` });
      }
      const file = scope === "project" ? projectFile(documents, project) : userFile(documents);
      const text = yield* readText(file);
      if (text.trim() !== "" && !isRecord(parseJsonc(text))) {
        return yield* new HarnessFailure({
          provider: "opencode",
          message: `${file} isn't valid JSON`,
          cause: undefined,
        });
      }
      yield* rewriteFile(file, (current) => {
        return editJsonc(current, [...serverPath(current, server.name)], toOpenCodeServer(server));
      }).pipe(Effect.mapError(failure(`Could not write ${file}`)));
      yield* settled(project, (documents) =>
        openCodeServers(documents, project).some((each) => each.name === server.name),
      );
      return file;
    });

  return {
    support: { servers: "project", tools: "none", skills: "project", status: true },
    read: (project) => Effect.provide(read(project), platform),
    status: (project) =>
      Effect.gen(function* () {
        // A location's servers start connecting on its first request, and appear only once they have.
        const expected = openCodeServers(yield* documentsOf(project), project).filter(
          (server) => server.enabled,
        ).length;
        const list = withClient((client) =>
          call("list its MCP servers", (signal) =>
            client.mcp.list({ location: { directory: project } }, { signal }),
          ),
        );
        const deadline = Date.now() + STATUS_WAIT_MS;
        let listed = yield* list;
        while (
          Date.now() < deadline &&
          (listed.data.length < expected || listed.data.some((server) => server.status.status === "pending"))
        ) {
          yield* Effect.sleep("1 second");
          listed = yield* list;
        }
        return listed;
      }).pipe(
        Effect.map(({ data }) =>
          data.map((server): HubServerStatus => ({
            name: server.name,
            connection: connectionOf(server.status.status),
            ...("error" in server.status ? { error: server.status.error } : {}),
          })),
        ),
      ),
    setServer: (project, server, enabled) =>
      Effect.provide(setPolicy(project, `mcp:${server.name}`, enabled), platform),
    setSkill: (project, skill, enabled) =>
      Effect.provide(setPolicy(project, `skill:${skill.name}`, enabled), platform),
    addServer: (project, scope, server) => Effect.provide(addServer(project, scope, server), platform),
    skillsFolder: (project, scope) =>
      // The cross-harness `.agents/skills` folders, which OpenCode reads beside its own.
      Effect.succeed(scope === "user" ? `${homedir()}/.agents/skills` : `${project}/.agents/skills`),
  };
};
