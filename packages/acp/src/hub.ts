import {
  HubConflict,
  editJsonc,
  fromMcpJson,
  isRecord,
  parseJsonc,
  readSkillFolders,
  rewriteFile,
  type HarnessHub,
  type PortableServer,
} from "@cerium/harness";
import type { HubScope, HubServer, HubSkill, HubTargetScope, SkillInfo } from "@cerium/protocol";
import { Effect, FileSystem, Path, Semaphore } from "effect";

import { harnessFailure, type AcpHarness } from "./harness.ts";

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const serverMap = (text: string) => {
  const config = text.trim() === "" ? {} : parseJsonc(text);
  if (!isRecord(config)) return undefined;
  const entries = config["mcpServers"];
  return entries === undefined ? {} : isRecord(entries) ? entries : undefined;
};

/** The JSONC used by ACP harnesses with an `mcpServers` map. */
const jsonMcpConfig = (harness: AcpHarness) => {
  const failure = harnessFailure(harness);
  const invalid = (file: string) => failure(`Invalid ${harness.label} MCP configuration in ${file}`);
  const read = Effect.fn("Acp.hub.readMcp")(function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
      Effect.mapError(() => failure(`Could not read ${harness.label} MCP configuration in ${file}`)),
    );
    const entries = serverMap(content);
    if (entries === undefined) return yield* invalid(file);
    return entries;
  });
  const edit = (
    file: string,
    change: (
      text: string,
      entries: Record<string, unknown>,
    ) => string | HubConflict | ReturnType<typeof failure>,
  ) =>
    Effect.gen(function* () {
      yield* read(file);
      let error: HubConflict | ReturnType<typeof failure> | undefined;
      yield* rewriteFile(file, (text) => {
        const entries = serverMap(text);
        const updated = entries === undefined ? invalid(file) : change(text, entries);
        if (typeof updated === "string") return updated;
        error = updated;
        return text;
      }).pipe(Effect.mapError(() => failure(`Could not edit ${harness.label} MCP configuration in ${file}`)));
      if (error !== undefined) return yield* error;
    });
  const add = (file: string, server: PortableServer, value: object) =>
    edit(file, (text, entries) =>
      Object.hasOwn(entries, server.name)
        ? new HubConflict({ message: `${server.name} is already configured in ${file}` })
        : editJsonc(text, ["mcpServers", server.name], value),
    ).pipe(Effect.as(file));
  const set = (file: string, name: string, key: string, value: (entry: Record<string, unknown>) => unknown) =>
    edit(file, (text, entries) => {
      const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
      return isRecord(entry)
        ? editJsonc(text, ["mcpServers", name, key], value(entry))
        : failure(`${name} is no longer configured in ${file}`);
    }).pipe(Effect.mapError((error) => (error._tag === "HubConflict" ? failure(error.message) : error)));
  return { read, add, set };
};

/** Directories from the working folder to its Git root, closest first. */
export const projectFolders = Effect.fn("Acp.hub.projectFolders")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const start = path.resolve(cwd);
  const folders = [start];
  let dir = start;
  for (;;) {
    if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false))) return folders;
    const parent = path.dirname(dir);
    if (parent === dir) return [start];
    folders.push(parent);
    dir = parent;
  }
});

export const readAcpSkillFolders = (folders: ReadonlyArray<readonly [string, HubScope]>) =>
  Effect.forEach(folders, ([folder, scope]) => readSkillFolders(folder, scope)).pipe(
    Effect.map((skills) => skills.flat()),
  );

/** The first folder that defines a name wins. The composer carries the definition's path. */
export const acpSkillInfos = (skills: ReadonlyArray<HubSkill>, path: Path.Path): ReadonlyArray<SkillInfo> => {
  const listed = new Map<string, SkillInfo>();
  for (const { name, description, path: folder, enabled } of skills) {
    if (!enabled || listed.has(name)) continue;
    listed.set(name, {
      name,
      ...(description === undefined ? {} : { description }),
      path: path.join(folder, "SKILL.md"),
    });
  }
  return [...listed.values()].sort((a, b) => a.name.localeCompare(b.name));
};

type Disk = FileSystem.FileSystem | Path.Path;
type HubLocation = readonly [file: string, scope: HubScope];

interface JsonHubOptions {
  readonly harness: AcpHarness;
  /** In descending precedence. A definition in a nearer file takes priority by name. */
  readonly files: (project: string) => Effect.Effect<ReadonlyArray<HubLocation>, never, Disk>;
  readonly copyFile: (project: string, scope: HubTargetScope) => Effect.Effect<string, never, Disk>;
  readonly skills: (project: string) => Effect.Effect<ReadonlyArray<HubSkill>, never, Disk>;
  readonly skillsFolder: (project: string, scope: HubTargetScope) => Effect.Effect<string, never, Disk>;
  readonly decode: (entry: Record<string, unknown>) => Record<string, unknown>;
  readonly encode: (server: PortableServer) => object | undefined;
}

/** A hub for ACP CLIs that use scoped JSONC MCP files and a native `disabled` flag and tool denylist. */
export const makeJsonMcpHub = Effect.fn("Acp.hub.jsonMcpHub")(function* (options: JsonHubOptions) {
  const { harness, files, copyFile, skills, skillsFolder, decode, encode } = options;
  const platform = yield* Effect.context<Disk>();
  const path = yield* Path.Path;
  const config = jsonMcpConfig(harness);
  const lock = yield* Semaphore.make(1);
  const failure = harnessFailure(harness);
  const readServers = (project: string) =>
    Effect.gen(function* () {
      const servers = new Map<string, HubServer>();
      for (const [file, scope] of yield* files(project)) {
        const entries = yield* config.read(file);
        for (const [name, entry] of Object.entries(entries)) {
          if (servers.has(name) || !isRecord(entry)) continue;
          const server = fromMcpJson(name, decode(entry), scope, file);
          if (server === undefined) continue;
          servers.set(name, {
            ...server,
            enabled: entry["disabled"] !== true,
            disabledTools: stringArray(entry["disabledTools"]),
          });
        }
      }
      return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  const set = (
    project: string,
    server: HubServer,
    key: string,
    value: (entry: Record<string, unknown>) => unknown,
  ) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const current = (yield* readServers(project)).find(({ name }) => name === server.name);
          if (current?.file === undefined || current.file !== server.file) {
            return yield* failure(
              `${server.name}'s MCP configuration changed. Refresh the hub and try again.`,
            );
          }
          yield* config.set(current.file, current.name, key, value);
        }),
      )
      .pipe(Effect.provide(platform));

  const hub: HarnessHub = {
    support: { servers: "everywhere", tools: "everywhere", skills: "none", status: false },
    read: (project) =>
      Effect.all({ servers: readServers(project), skills: skills(project) }).pipe(Effect.provide(platform)),
    setServer: (project, server, enabled) => set(project, server, "disabled", () => !enabled || undefined),
    setTool: (project, server, tool, enabled) =>
      set(project, server, "disabledTools", (entry) => {
        const disabled = new Set(stringArray(entry["disabledTools"]));
        if (enabled) disabled.delete(tool);
        else disabled.add(tool);
        return disabled.size > 0 ? [...disabled] : undefined;
      }),
    addServer: (project, scope, server) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const value = encode(server);
            if (value === undefined) {
              return yield* failure(`${harness.label} does not support ${server.transport} MCP servers`);
            }
            const target = yield* copyFile(project, scope);
            const existing = yield* readServers(project);
            if (existing.some((entry) => entry.scope === scope && entry.name === server.name)) {
              return yield* new HubConflict({
                message: `${server.name} is already configured for this scope`,
              });
            }
            return yield* config.add(target, server, value);
          }),
        )
        .pipe(Effect.provide(platform)),
    skillsFolder: (project, scope) => skillsFolder(project, scope).pipe(Effect.provide(platform)),
  };
  return {
    hub,
    listSkills: (cwd: string) =>
      skills(cwd).pipe(
        Effect.map((items) => acpSkillInfos(items, path)),
        Effect.provide(platform),
      ),
  };
});
