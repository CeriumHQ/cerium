import { array, record, string, type AcpConnection } from "@cerium/acp";
import {
  HubConflict,
  blankValues,
  fromMcpJson,
  type HarnessHub,
  type HarnessUnavailable,
} from "@cerium/harness";
import type { HubConnection, HubServer, HubServerStatus, HubSkill, SkillInfo } from "@cerium/protocol";
import { Effect, Path, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";

import { failure } from "./manifest.ts";

/** Only the connection state and tool names and descriptions leave the live ACP report. */
export const readGrokMcpStatus = (acp: AcpConnection, sessionId: string) =>
  acp.call("_x.ai/mcp/list", { sessionId }, "5 seconds").pipe(
    Effect.map((answer) =>
      array(record(record(answer)?.["result"])?.["servers"]).flatMap(
        (item): ReadonlyArray<HubServerStatus> => {
          const server = record(item);
          const name = string(server?.["name"]);
          const state = record(server?.["session"]);
          if (!name || state === undefined) return [];
          const status = state["status"];
          const connection: HubConnection =
            state["enabled"] === false || status === "disabled"
              ? "disabled"
              : status === "ready"
                ? "connected"
                : status === "initializing"
                  ? "starting"
                  : status === "auth_required" || status === "needs_auth"
                    ? "needsAuth"
                    : "failed";
          const tools = Array.isArray(state["tools"])
            ? state["tools"].flatMap((value) => {
                const tool = record(value);
                const toolName = string(tool?.["name"]);
                const description = string(tool?.["description"]);
                return toolName
                  ? [{ name: toolName, ...(description === undefined ? {} : { description }) }]
                  : [];
              })
            : undefined;
          return [{ name, connection, ...(tools === undefined ? {} : { tools }) }];
        },
      ),
    ),
  );

/** Grok's CLI handles the TOML layers, imported config and project trust. */
export const makeGrokHub = Effect.fn("Grok.hub")(function* (
  executable: Effect.Effect<string, HarnessUnavailable>,
  home = process.env["GROK_HOME"] || `${homedir()}/.grok`,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const userFile = path.join(home, "config.toml");
  // `mcp list` itself expands environment references, including those in the URL or arguments.
  // Only pass environment needed to locate the user's configuration when inspecting it.
  const discoveryEnv = Object.fromEntries(
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "PATH", "XDG_CONFIG_HOME"].flatMap(
      (key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      },
    ),
  );
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const cli = yield* executable;
      const inspecting = args.includes("--json");
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(cli, ["--no-auto-update", ...args], {
            cwd,
            env: {
              ...(inspecting ? discoveryEnv : {}),
              GROK_HOME: home,
              GROK_DISABLE_AUTOUPDATER: "1",
              GROK_TELEMETRY_ENABLED: "0",
            },
            extendEnv: !inspecting,
            stderr: "ignore",
          }),
        )
        .pipe(Effect.mapError(() => failure("Could not run the Grok Build configuration command")));
      const [output, exit] = yield* Effect.all(
        [Stream.mkString(handle.stdout.pipe(Stream.decodeText())), handle.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => failure("Could not read the Grok Build configuration command's result")));
      if (exit !== 0)
        return yield* failure(`Grok Build could not ${args.slice(0, 2).join(" ")} (exit ${exit})`);
      return output;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(failure("Grok Build did not finish reading or editing its configuration")),
      }),
    );

  const readJson = (cwd: string, args: ReadonlyArray<string>) =>
    run(cwd, args).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: (): unknown => JSON.parse(text),
          // Config output can contain expanded env and header values. Keep raw output out of errors.
          catch: () => failure("Grok Build returned invalid configuration JSON"),
        }),
      ),
    );

  const readServers = (project: string) =>
    readJson(project, ["mcp", "list", "--json"]).pipe(
      Effect.flatMap((value) =>
        Array.isArray(value)
          ? Effect.succeed(
              value
                .flatMap((item): ReadonlyArray<HubServer> => {
                  const entry = record(item);
                  const name = string(entry?.["name"]);
                  if (!name || entry === undefined) return [];
                  const declared = entry["scope"];
                  const scope = declared === "user" || declared === "project" ? declared : "bundled";
                  const server = fromMcpJson(name, entry, scope, scope === "user" ? userFile : undefined);
                  return server === undefined ? [] : [{ ...server, enabled: entry["enabled"] !== false }];
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
            )
          : Effect.fail(failure("Grok Build returned an invalid MCP server list")),
      ),
    );

  const inspectSkills = (project: string) =>
    readJson(project, ["inspect", "--json"]).pipe(
      Effect.flatMap((value) => {
        const skills = record(value)?.["skills"];
        if (!Array.isArray(skills)) return Effect.fail(failure("Grok Build returned an invalid skill list"));
        return Effect.succeed(
          array(skills).flatMap((item) => {
            const skill = record(item);
            const name = string(skill?.["name"]);
            const source = record(skill?.["source"]);
            const file = string(source?.["path"]);
            if (!name || !file || path.basename(file) !== "SKILL.md") return [];
            const type = source?.["type"];
            const description = string(skill?.["description"]);
            const hub: HubSkill = {
              name,
              ...(description === undefined ? {} : { description }),
              scope: type === "user" || type === "project" ? type : "bundled",
              path: path.dirname(file),
              enabled: true,
            };
            return [{ hub, file, invocable: skill?.["userInvocable"] !== false }];
          }),
        );
      }),
    );

  const hub: HarnessHub = {
    // The CLI's switches write the user's disabled list. Its doctor probes new connections separately.
    support: { servers: "everywhere", tools: "none", skills: "none", status: false },
    read: (project) =>
      Effect.all(
        {
          servers: readServers(project),
          skills: inspectSkills(project).pipe(Effect.map((items) => items.map((item) => item.hub))),
        },
        { concurrency: "unbounded" },
      ),
    setServer: (project, server, enabled) =>
      lock.withPermit(
        Effect.gen(function* () {
          const match = (yield* readServers(project)).find(({ name }) => name === server.name);
          if (match === undefined || match.scope !== server.scope || match.scope === "bundled") {
            return yield* failure(
              `${server.name}'s MCP configuration changed. Refresh the hub and try again.`,
            );
          }
          yield* run(project, ["mcp", enabled ? "enable" : "disable", "--", server.name]);
        }),
      ),
    addServer: (project, scope, server) =>
      lock.withPermit(
        Effect.gen(function* () {
          // `mcp add` also updates existing servers. A project entry can shadow a user entry, so
          // reject any matching name in the effective listing when copying into user scope.
          const servers = yield* readServers(project);
          if (
            servers.some((item) => item.name === server.name && (item.scope === scope || scope === "user"))
          ) {
            return yield* new HubConflict({ message: `${server.name} is already configured for Grok Build` });
          }
          const stdio = server.transport === "stdio";
          const blanks = blankValues(stdio ? server.env : server.headers);
          const values = Object.entries(blanks).flatMap(([name, value]) =>
            stdio ? ["--env", `${name}=${value}`] : ["--header", `${name}:${value}`],
          );
          const target = stdio ? server.command : server.url;
          if (!target) return yield* failure("The MCP server has no command or URL");
          yield* run(project, [
            "mcp",
            "add",
            "--scope",
            scope,
            "--transport",
            server.transport,
            ...values,
            "--",
            server.name,
            target,
            ...(stdio ? (server.args ?? []) : []),
          ]);
          return scope === "user" ? userFile : path.resolve(project, ".grok", "config.toml");
        }),
      ),
    skillsFolder: (project, scope) =>
      Effect.succeed(scope === "user" ? path.join(home, "skills") : path.resolve(project, ".grok", "skills")),
  };
  return {
    hub,
    listSkills: (cwd: string) =>
      inspectSkills(cwd).pipe(
        Effect.map((items) => {
          const skills = new Map<string, SkillInfo>();
          for (const { hub, file, invocable } of items) {
            if (!invocable || skills.has(hub.name)) continue;
            const { name, description } = hub;
            skills.set(name, { name, path: file, ...(description === undefined ? {} : { description }) });
          }
          return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
        }),
      ),
  };
});
