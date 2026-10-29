import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  editJsonc,
  editJsoncPruned,
  fromMcpJson,
  HarnessFailure,
  HubConflict,
  type HarnessUnavailable,
  isRecord,
  parseJsonc,
  readSkillFolders,
  readText,
  rewriteFile,
  toMcpJson,
  type HarnessHub,
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
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { join } from "node:path";

import { inspectClaude } from "./models.ts";

// Claude Code's MCP servers and skills, in its own files:
// - servers: `~/.claude.json`'s `mcpServers` (user), its `projects[<folder>].mcpServers` (local), and
//   the project's `.mcp.json` (project). `/mcp` turns one off for a project in
//   `projects[<folder>].disabledMcpServers`, which the SDK's `toggleMcpServer` writes.
// - a server's tools: a `mcp__<server>__<tool>` deny rule in the project's `.claude/settings.local.json`.
// - skills: `~/.claude/skills` and the project's `.claude/skills`, turned off with `skillOverrides`
//   (`"off"`) in the project's `.claude/settings.local.json`.

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/** Claude Code's own folder, where it keeps its user settings and skills. */
const configDir = () => process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");

/** The file holding the user's servers and each project's state. */
const globalFile = () =>
  process.env["CLAUDE_CONFIG_DIR"] !== undefined
    ? join(process.env["CLAUDE_CONFIG_DIR"], ".claude.json")
    : join(homedir(), ".claude.json");

/** A folder as `~/.claude.json` keys it: forward slashes, and on Windows any case. */
const folderKey = (folder: string) => {
  const key = folder.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
};

/** The project's entry in `~/.claude.json`, matched however Claude Code spelled the folder. */
export const projectEntry = (global: unknown, project: string): Record<string, unknown> => {
  const projects = isRecord(global) && isRecord(global["projects"]) ? global["projects"] : {};
  const key = folderKey(project);
  const found = Object.entries(projects).find(([folder]) => folderKey(folder) === key)?.[1];
  return isRecord(found) ? found : {};
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A name as Claude Code spells it inside a tool's id. */
const toolPart = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The deny rule that keeps one of a server's tools from Claude Code. */
export const toolRule = (server: string, tool: string) => `mcp__${toolPart(server)}__${toolPart(tool)}`;

/** The settings files that apply in a project, lowest precedence first. */
const settingsFiles = (project: string) => [
  `${configDir()}/settings.json`,
  `${project}/.claude/settings.json`,
  `${project}/.claude/settings.local.json`,
];

/** The project's own settings file Cerium edits: personal, and kept out of git by Claude Code. */
const localSettings = (project: string) => `${project}/.claude/settings.local.json`;

/** The servers of one `mcpServers` object. */
const serversOf = (value: unknown, scope: HubScope, file: string): ReadonlyArray<HubServer> =>
  isRecord(value)
    ? Object.entries(value).flatMap(([name, config]) => {
        const server = fromMcpJson(name, config, scope, file);
        return server === undefined ? [] : [server];
      })
    : [];

/**
 * The servers and skills Claude Code offers a session in `project`, from the texts of its files. A
 * closer scope's server of the same name replaces a wider one, as Claude Code does (local, project, user).
 */
export const claudeListing = (files: {
  readonly project: string;
  readonly global: string;
  readonly mcpJson: string;
  /** The texts of `settingsFiles`, in their order. */
  readonly settings: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<HubSkill>;
}): HubListing => {
  const global = parseJsonc(files.global);
  const entry = projectEntry(global, files.project);
  const mcpJson = parseJsonc(files.mcpJson);
  const settings = files.settings.map(parseJsonc).filter(isRecord);
  const disabled = new Set(strings(entry["disabledMcpServers"]));
  const unapproved = new Set([
    ...strings(entry["disabledMcpjsonServers"]),
    ...settings.flatMap((each) => strings(each["disabledMcpjsonServers"])),
  ]);
  const denied = new Set(
    settings.flatMap((each) => (isRecord(each["permissions"]) ? strings(each["permissions"]["deny"]) : [])),
  );
  const overrides: Record<string, unknown> = Object.assign(
    {},
    ...settings.map((each) => (isRecord(each["skillOverrides"]) ? each["skillOverrides"] : {})),
  );

  const byName = new Map<string, HubServer>();
  const listed = [
    ...serversOf(isRecord(global) ? global["mcpServers"] : undefined, "user", globalFile()),
    ...serversOf(
      isRecord(mcpJson) ? mcpJson["mcpServers"] : undefined,
      "project",
      `${files.project}/.mcp.json`,
    ),
    ...serversOf(entry["mcpServers"], "local", globalFile()),
  ];
  for (const server of listed) byName.set(server.name, server);
  const servers = [...byName.values()].map((server) => ({
    ...server,
    enabled: !disabled.has(server.name) && !(server.scope === "project" && unapproved.has(server.name)),
    disabledTools: [...denied]
      .filter((rule) => rule.startsWith(`mcp__${toolPart(server.name)}__`))
      .map((rule) => rule.slice(`mcp__${toolPart(server.name)}__`.length)),
  }));
  const skills = files.skills.map((skill) => ({ ...skill, enabled: overrides[skill.name] !== "off" }));
  return { servers, skills };
};

const connectionOf = (status: string): HubConnection => {
  switch (status) {
    case "connected":
      return "connected";
    case "needs-auth":
      return "needsAuth";
    case "disabled":
      return "disabled";
    case "pending":
      return "starting";
    default:
      return "failed";
  }
};

/** Settles once no server is still connecting, or after `waitMs`, and answers their states. */
const settledStatus = async (session: Query, waitMs: number) => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const servers = await session.mcpServerStatus();
    if (Date.now() >= deadline || servers.every((server) => server.status !== "pending")) return servers;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
};

/** How long a status read waits for servers that are still connecting. */
const STATUS_WAIT_MS = 15_000;

export const makeClaudeHub = (
  ready: Effect.Effect<string, HarnessFailure | HarnessUnavailable>,
  platform: Context.Context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>,
): HarnessHub => {
  const read = Effect.fn("ClaudeAdapter.hub.read")(function* (project: string) {
    const path = yield* Path.Path;
    const [global, mcpJson, ...settings] = yield* Effect.forEach(
      [globalFile(), `${project}/.mcp.json`, ...settingsFiles(project)],
      readText,
    );
    const user = yield* readSkillFolders(path.join(configDir(), "skills"), "user");
    // A project in the home folder shares the user's skills folder.
    const own = yield* readSkillFolders(path.join(project, ".claude", "skills"), "project");
    const skills = [...user, ...own.filter((skill) => !user.some((each) => each.path === skill.path))];
    return claudeListing({ project, global: global ?? "", mcpJson: mcpJson ?? "", settings, skills });
  });

  /** Edits the project's `.claude/settings.local.json`, refusing one that isn't valid JSON. */
  const editLocal = (project: string, edit: (settings: Record<string, unknown>, text: string) => string) =>
    Effect.gen(function* () {
      const file = localSettings(project);
      const text = yield* readText(file);
      const parsed = parseJsonc(text);
      if (text.trim() !== "" && !isRecord(parsed)) {
        return yield* new HarnessFailure({
          provider: "claude",
          message: `${file} isn't valid JSON`,
          cause: undefined,
        });
      }
      yield* rewriteFile(file, (current) => {
        const settings = parseJsonc(current);
        return edit(isRecord(settings) ? settings : {}, current);
      }).pipe(Effect.mapError(failure("Could not change Claude Code's project settings")));
    });

  /**
   * Adds the server to the project's `disabledMcpServers` in `~/.claude.json`, or takes it out, under
   * the project's key as Claude Code spelled it. Turning a `.mcp.json` server on also approves it.
   */
  const switchServer = Effect.fn("ClaudeAdapter.hub.setServer")(function* (
    project: string,
    name: string,
    enabled: boolean,
  ) {
    const file = globalFile();
    const text = yield* readText(file);
    const global = parseJsonc(text);
    if (!isRecord(global)) {
      return yield* new HarnessFailure({
        provider: "claude",
        message: `${file} isn't valid JSON`,
        cause: undefined,
      });
    }
    yield* rewriteFile(file, (current) => {
      const parsed = parseJsonc(current);
      const projects = isRecord(parsed) && isRecord(parsed["projects"]) ? parsed["projects"] : {};
      const key =
        Object.keys(projects).find((folder) => folderKey(folder) === folderKey(project)) ??
        project.replaceAll("\\", "/");
      const entry = projectEntry(parsed, project);
      const disabled = strings(entry["disabledMcpServers"]);
      let next = editJsonc(
        current,
        ["projects", key, "disabledMcpServers"],
        enabled ? disabled.filter((each) => each !== name) : [...new Set([...disabled, name])],
      );
      const unapproved = strings(entry["disabledMcpjsonServers"]);
      if (enabled && unapproved.includes(name)) {
        next = editJsonc(
          next,
          ["projects", key, "disabledMcpjsonServers"],
          unapproved.filter((each) => each !== name),
        );
      }
      return next;
    }).pipe(Effect.mapError(failure(`Could not write ${file}`)));
  });

  const addWithClaude = Effect.fn("ClaudeAdapter.hub.addServer")(function* (
    project: string,
    scope: HubTargetScope,
    server: PortableServer,
  ) {
    const listing = yield* read(project);
    if (
      listing.servers.some((each) => each.name === server.name && (each.scope === scope || scope === "user"))
    ) {
      return yield* new HubConflict({ message: `Claude Code already has a server named ${server.name}.` });
    }
    const executable = yield* ready;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Claude Code writes its own config: `.mcp.json` for the project, `~/.claude.json` for the user.
    const exit = yield* spawner
      .exitCode(
        ChildProcess.make(
          executable,
          ["mcp", "add-json", "--scope", scope, server.name, JSON.stringify(toMcpJson(server))],
          { cwd: project },
        ),
      )
      .pipe(Effect.mapError(failure("Could not run `claude mcp add-json`")));
    if (exit !== 0) {
      return yield* new HarnessFailure({
        provider: "claude",
        message: `\`claude mcp add-json\` exited with ${exit}`,
        cause: undefined,
      });
    }
    return scope === "user" ? globalFile() : `${project}/.mcp.json`;
  });

  const provided = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
  ) => Effect.provide(effect, platform);

  return {
    support: { servers: "project", tools: "project", skills: "project", status: true },
    read: (project) => provided(read(project)),
    status: (project) =>
      ready.pipe(
        Effect.flatMap((executable) =>
          inspectClaude(executable, project, "Could not read Claude Code's MCP servers", (session) =>
            settledStatus(session, STATUS_WAIT_MS),
          ),
        ),
        Effect.map((servers) =>
          servers.map((server): HubServerStatus => ({
            name: server.name,
            connection: connectionOf(server.status),
            ...(server.error ? { error: server.error } : {}),
            ...(server.tools
              ? {
                  tools: server.tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.description ? { description: tool.description } : {}),
                  })),
                }
              : {}),
          })),
        ),
      ),
    // `/mcp`'s own switch, kept where `/mcp` keeps it. (The SDK's `toggleMcpServer` only switches the
    // session it's sent to.)
    setServer: (project, server, enabled) => provided(switchServer(project, server.name, enabled)),
    setTool: (project, server, tool, enabled) =>
      provided(
        editLocal(project, (settings, text) => {
          const rule = toolRule(server.name, tool);
          const permissions = isRecord(settings["permissions"]) ? settings["permissions"] : {};
          const deny = strings(permissions["deny"]);
          const next = enabled
            ? deny.filter((each) => each !== rule)
            : deny.includes(rule)
              ? deny
              : [...deny, rule];
          return next.length === deny.length && (enabled || deny.includes(rule))
            ? text
            : editJsoncPruned(text, ["permissions", "deny"], next);
        }),
      ),
    setSkill: (project, skill, enabled) =>
      provided(
        Effect.gen(function* () {
          // Off in a wider file (the user's, the project's shared one) needs an explicit "on" to undo here.
          const [user, shared] = yield* Effect.forEach(settingsFiles(project).slice(0, 2), readText);
          const offElsewhere = [user, shared].some((text) => {
            const parsed = parseJsonc(text ?? "");
            return (
              isRecord(parsed) &&
              isRecord(parsed["skillOverrides"]) &&
              parsed["skillOverrides"][skill.name] === "off"
            );
          });
          yield* editLocal(project, (_, text) =>
            editJsoncPruned(
              text,
              ["skillOverrides", skill.name],
              enabled ? (offElsewhere ? "on" : undefined) : "off",
            ),
          );
        }),
      ),
    addServer: (project, scope, server) => provided(addWithClaude(project, scope, server)),
    skillsFolder: (project, scope) =>
      Effect.succeed(scope === "user" ? `${configDir()}/skills` : `${project}/.claude/skills`),
  };
};
