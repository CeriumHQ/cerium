import type { TurnExtras } from "@cerium/harness";
import type { HubScope, HubSkill, SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";
import { dirname } from "node:path";

import { failure, record, string, type CopilotHost } from "./rpc.ts";

// Copilot's skills, as `skills.discover` finds them for a project: the personal folders
// (`~/.copilot/skills`, `~/.agents/skills`), the project's (`.github/skills`, `.agents/skills`,
// `.claude/skills`), plugins' and the CLI's own, with whether each is turned off (`disabledSkills`).

export interface DiscoveredSkill {
  readonly name: string;
  /** The slash command that runs it, when it differs from its name. */
  readonly command: string;
  readonly description?: string;
  readonly scope: HubScope;
  /** Its `SKILL.md`. */
  readonly file?: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
}

/** A skill's source as the hub's scope: the user's own, the project's, or the CLI's or a plugin's. */
const scopeOf = (source: string): HubScope =>
  source.startsWith("personal") || source === "custom"
    ? "user"
    : source === "project" || source === "inherited"
      ? "project"
      : "bundled";

export const toDiscoveredSkill = (value: unknown): ReadonlyArray<DiscoveredSkill> => {
  const skill = record(value);
  const name = string(skill?.["name"]);
  if (!skill || !name) return [];
  const description = string(skill["description"]);
  const file = string(skill["path"]);
  return [
    {
      name,
      command: string(skill["commandName"]) ?? name,
      ...(description ? { description } : {}),
      scope: scopeOf(string(skill["source"]) ?? ""),
      ...(file ? { file } : {}),
      enabled: skill["enabled"] !== false,
      userInvocable: skill["userInvocable"] !== false,
    },
  ];
};

export const discoverSkills = Effect.fn("CopilotAdapter.discoverSkills")(function* (
  host: CopilotHost,
  project: string,
) {
  const listed = record(yield* host.request("skills.discover", { projectPaths: [project] }));
  const skills = listed?.["skills"];
  if (!Array.isArray(skills)) {
    return yield* failure("GitHub Copilot CLI returned an invalid skill list")(listed);
  }
  return skills.flatMap(toDiscoveredSkill);
});

/** The skills a user can run in `cwd`, for the message box's `$` list. */
export const listCopilotSkills = (host: CopilotHost, cwd: string) =>
  discoverSkills(host, cwd).pipe(
    Effect.map((skills) =>
      skills
        .filter((skill) => skill.enabled && skill.userInvocable)
        .map((skill): SkillInfo => ({
          name: skill.command,
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.file ? { path: skill.file } : {}),
        })),
    ),
  );

/** A discovered skill as the hub shows it: its folder, which holds its `SKILL.md`. */
export const toHubSkill = (skill: DiscoveredSkill): ReadonlyArray<HubSkill> =>
  skill.file === undefined
    ? []
    : [
        {
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          scope: skill.scope,
          path: dirname(skill.file),
          enabled: skill.enabled,
        },
      ];

/** Expand only native skill commands this live session offers. Leave stale picks in the user text. */
export const expandCopilotSkills = Effect.fn("CopilotAdapter.expandSkills")(function* (
  host: CopilotHost,
  sessionId: string,
  skills: TurnExtras["skills"],
) {
  if (skills === undefined || skills.length === 0) return [];
  const listed = record(
    yield* host.request(
      "session.commands.list",
      {
        sessionId,
        includeBuiltins: false,
        includeSkills: true,
        includeClientCommands: false,
      },
      "5 seconds",
    ),
  )?.["commands"];
  if (!Array.isArray(listed)) return [];
  const names = new Set(
    listed.flatMap((value) => {
      const command = record(value);
      const name = string(command?.["name"]);
      return command?.["kind"] === "skill" && name ? [name] : [];
    }),
  );
  const expanded: Array<string> = [];
  for (const name of new Set(skills.map((skill) => skill.name))) {
    if (!names.has(name)) continue;
    const result = record(yield* host.request("session.commands.invoke", { sessionId, name }, "5 seconds"));
    const prompt = string(result?.["prompt"]);
    if (result?.["kind"] === "agent-prompt" && prompt) expanded.push(prompt);
  }
  return expanded;
});
