import {
  editJsonc,
  fromMcpJson,
  HarnessFailure,
  HubConflict,
  isRecord,
  parseJsonc,
  readText,
  rewriteFile,
  toMcpJson,
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
  HubTargetScope,
  HubTransport,
} from "@cerium/protocol";
import { Effect, FileSystem, Path, Semaphore, type Context } from "effect";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { listCopilotModels } from "./models.ts";
import { record, string, type CopilotHost } from "./rpc.ts";
import { CLIENT_NAME } from "./session.ts";
import { discoverSkills, toHubSkill } from "./skills.ts";

// Copilot's MCP servers and skills, as the CLI itself finds and switches them:
// - servers: `mcp.discover` reports the user's (`~/.copilot/mcp-config.json`), the project's
//   (`.mcp.json` or `.github/mcp.json`, loaded only in a folder the user trusted), plugins' and the
//   CLI's own, each with the file and JSON pointer it's declared at, which the hub reads for its shape.
//   `mcp.config.disable` and `mcp.config.enable` keep `disabledMcpServers` in the user's settings, so a
//   server turns off everywhere; the CLI has no switch per project or per tool.
// - skills: `skills.discover` (skills.ts), turned off everywhere with `skills.config.setSkillDisabled`.
// - a copied server goes in with `mcp.config.add` (the user's file) or into the project's `.mcp.json`.

type Platform = FileSystem.FileSystem | Path.Path;
type WithHost = <A, E>(
  use: (host: CopilotHost) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | HarnessUnavailable | HarnessFailure>;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "copilot", message, cause });

/** Copilot's folder for its configuration and state, which `COPILOT_HOME` moves. */
export const copilotHome = () => process.env["COPILOT_HOME"] ?? join(homedir(), ".copilot");

const projectFile = (project: string) => join(project, ".mcp.json");

/** A server's source as the hub's scope: the user's, the project's, or a plugin's or the CLI's own. */
const scopeOf = (source: string): HubScope =>
  source === "user" ? "user" : source === "workspace" ? "project" : "bundled";

const transportOf = (type: unknown): HubTransport | undefined =>
  type === "http"
    ? "http"
    : type === "sse"
      ? "sse"
      : type === "stdio" || type === "local"
        ? "stdio"
        : undefined;

/** The value an RFC 6901 pointer names in a parsed document. */
export const atPointer = (document: unknown, pointer: string): unknown => {
  if (!pointer.startsWith("/")) return pointer === "" ? document : undefined;
  let at = document;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    at = isRecord(at) ? at[key] : undefined;
  }
  return at;
};

export interface Discovered {
  readonly name: string;
  readonly type?: unknown;
  readonly source: string;
  readonly enabled: boolean;
  /** The file it's declared in, and where in it. */
  readonly file?: string;
  readonly pointer?: string;
}

export const toDiscovered = (value: unknown): ReadonlyArray<Discovered> => {
  const server = record(value);
  const name = string(server?.["name"]);
  if (!server || !name) return [];
  const location = record(record(server["effectiveSource"])?.["file"]);
  const uri = string(location?.["uri"]);
  let file: string | undefined;
  try {
    file = uri?.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    file = undefined;
  }
  const pointer = string(location?.["jsonPointer"]);
  return [
    {
      name,
      type: server["type"],
      source: string(server["source"]) ?? "",
      enabled: server["enabled"] !== false,
      ...(file ? { file } : {}),
      ...(pointer ? { pointer } : {}),
    },
  ];
};

/**
 * A discovered server with its shape, read from the file it's declared in, its secrets by name only. A
 * server with no file (a plugin's, the CLI's own) shows its transport alone.
 */
export const toHubServer = (
  server: Discovered,
  texts: ReadonlyMap<string, string>,
): HubServer | undefined => {
  const scope = scopeOf(server.source);
  const text = server.file === undefined ? undefined : texts.get(server.file);
  const declared =
    text === undefined
      ? undefined
      : atPointer(
          parseJsonc(text),
          server.pointer ?? `/mcpServers/${server.name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
  const read = fromMcpJson(server.name, declared, scope, server.file);
  if (read !== undefined) return { ...read, enabled: server.enabled };
  const transport = transportOf(server.type);
  if (transport === undefined) return undefined;
  return {
    name: server.name,
    scope,
    transport,
    env: [],
    headers: [],
    enabled: server.enabled,
    disabledTools: [],
    ...(server.file === undefined ? {} : { file: server.file }),
  };
};

const connectionOf = (status: unknown): HubConnection => {
  switch (status) {
    case "connected":
      return "connected";
    case "needs-auth":
      return "needsAuth";
    case "pending":
      return "starting";
    case "disabled":
    case "stopped":
    case "not_configured":
      return "disabled";
    default:
      return "failed";
  }
};

/** The CLI can report live status only inside a session. Inspect one without sending a model prompt. */
const inspectStatus = (host: CopilotHost, project: string) =>
  Effect.gen(function* () {
    const [model] = yield* listCopilotModels(host);
    const sessionId = randomUUID();
    yield* Effect.addFinalizer(() =>
      host.request("session.delete", { sessionId }, "3 seconds").pipe(Effect.ignore),
    );
    yield* host.request("session.create", {
      sessionId,
      workingDirectory: project,
      ...(model === undefined ? {} : { model: model.id }),
      clientName: CLIENT_NAME,
      enableConfigDiscovery: true,
      permissions: { mode: "manual", request: true },
      tools: { availableTools: [] },
      extensions: { enabled: false },
      state: { memory: { enabled: false }, enableCrossSessionStore: false },
      filesystem: { trackFileChanges: false },
    });
    const listed = record(yield* host.request("session.mcp.list", { sessionId }, "20 seconds"))?.["servers"];
    if (!Array.isArray(listed)) {
      return yield* failure("GitHub Copilot CLI returned an invalid MCP status list")(undefined);
    }
    return yield* Effect.forEach(
      listed.flatMap((value) => {
        const server = record(value);
        const name = string(server?.["name"]);
        return name === undefined ? [] : [{ name, connection: connectionOf(server?.["status"]) }];
      }),
      (server) => {
        if (server.connection !== "connected") return Effect.succeed<HubServerStatus>(server);
        return host
          .request("session.mcp.listTools", { sessionId, serverName: server.name }, "5 seconds")
          .pipe(
            Effect.map((result): HubServerStatus => {
              const tools = record(result)?.["tools"];
              return !Array.isArray(tools)
                ? server
                : {
                    ...server,
                    tools: tools.flatMap((value) => {
                      const tool = record(value);
                      const name = string(tool?.["name"]);
                      const description = string(tool?.["description"]);
                      return name ? [{ name, ...(description ? { description } : {}) }] : [];
                    }),
                  };
            }),
            Effect.orElseSucceed((): HubServerStatus => server),
          );
      },
      { concurrency: 4 },
    );
  }).pipe(Effect.scoped);

export const makeCopilotHub = (withHost: WithHost, platform: Context.Context<Platform>): HarnessHub => {
  const writes = Semaphore.makeUnsafe(1);
  const provided = <A, E>(effect: Effect.Effect<A, E, Platform>) => Effect.provide(effect, platform);

  const read = (project: string) =>
    withHost((host) =>
      Effect.gen(function* () {
        const discovered = record(
          yield* host.request("mcp.discover", { workingDirectory: project, includeEffectiveSource: true }),
        )?.["servers"];
        const servers = Array.isArray(discovered) ? discovered.flatMap(toDiscovered) : [];
        const files = [...new Set(servers.flatMap((server) => (server.file ? [server.file] : [])))];
        const texts = new Map<string, string>();
        for (const file of files) texts.set(file, yield* provided(readText(file)));
        const skills = yield* discoverSkills(host, project);
        return {
          servers: servers.flatMap((server) => {
            const shown = toHubServer(server, texts);
            return shown === undefined ? [] : [shown];
          }),
          skills: skills.flatMap(toHubSkill),
        } satisfies HubListing;
      }),
    );

  const addServer = (project: string, scope: HubTargetScope, server: PortableServer) =>
    Effect.gen(function* () {
      const file = scope === "user" ? join(copilotHome(), "mcp-config.json") : projectFile(project);
      const text = yield* provided(readText(file));
      const config = parseJsonc(text);
      const existing = isRecord(config) ? config["mcpServers"] : undefined;
      if (text.trim() !== "" && (!isRecord(config) || (existing !== undefined && !isRecord(existing)))) {
        return yield* failure(`${file} isn't valid MCP configuration`)(undefined);
      }
      if (isRecord(existing) && Object.hasOwn(existing, server.name)) {
        return yield* new HubConflict({ message: `${file} already has a server named ${server.name}.` });
      }
      if (scope === "user") {
        yield* withHost((host) =>
          host.request("mcp.config.add", { name: server.name, config: toMcpJson(server) }),
        );
        return file;
      }
      yield* provided(
        rewriteFile(file, (current) =>
          editJsonc(current, ["mcpServers", server.name], toMcpJson(server)),
        ).pipe(Effect.mapError(failure(`Could not write ${file}`))),
      );
      return file;
    });

  return {
    support: { servers: "everywhere", tools: "none", skills: "everywhere", status: true },
    read,
    status: (project) => withHost((host) => inspectStatus(host, project)),
    setServer: (_project, server, enabled) =>
      withHost((host) =>
        host.request(enabled ? "mcp.config.enable" : "mcp.config.disable", { names: [server.name] }),
      ).pipe(Effect.asVoid),
    setSkill: (_project, skill, enabled) =>
      withHost((host) =>
        host.request("skills.config.setSkillDisabled", { name: skill.name, disabled: !enabled }),
      ).pipe(Effect.asVoid),
    addServer: (project, scope, server) => writes.withPermit(addServer(project, scope, server)),
    skillsFolder: (project, scope) =>
      Effect.succeed(scope === "user" ? join(copilotHome(), "skills") : join(project, ".github", "skills")),
  };
};
