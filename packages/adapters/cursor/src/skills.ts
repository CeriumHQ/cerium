import { readSkillFolders } from "@cerium/harness";
import type { HubSkill, SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

// The skill folders `@cursor/sdk`'s local runtime scans, in its order: its own `.cursor/skills` and the
// shared `.agents/skills`, in the user's home and in the project, then the skills Cursor ships in
// `~/.cursor/skills-cursor`. The SDK also reads `.claude`, `.codex` and `.grok` skills, but only when
// third-party skills are switched on in Cursor, which Cerium can't see, so those are left out.

const FOLDERS = [".cursor/skills", ".agents/skills"] as const;

/** The skills a Cursor session in `project` is offered. A name an earlier folder holds wins. */
export const readCursorSkills = Effect.fn("CursorAdapter.readSkills")(function* (
  project: string,
  home: string = homedir(),
) {
  const found: Array<HubSkill> = [];
  for (const folder of FOLDERS) found.push(...(yield* readSkillFolders(join(home, folder), "user")));
  // A project in the home folder shares the user's folders.
  if (project !== home) {
    for (const folder of FOLDERS) found.push(...(yield* readSkillFolders(join(project, folder), "project")));
  }
  found.push(...(yield* readSkillFolders(join(home, ".cursor", "skills-cursor"), "bundled")));
  const byName = new Map<string, HubSkill>();
  for (const skill of found) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
});

/** The skills for the message box's `$` list. */
export const listCursorSkills = (project: string, home?: string) =>
  readCursorSkills(project, home).pipe(
    Effect.map((skills) =>
      skills.map((skill): SkillInfo => ({
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        path: join(skill.path, "SKILL.md"),
      })),
    ),
  );
