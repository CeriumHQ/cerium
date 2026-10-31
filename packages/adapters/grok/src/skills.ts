import { withAcpAgent } from "@cerium/adapter-acp";
import { HarnessFailure } from "@cerium/harness";
import type { SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";

import { grokExtension, grokHarness } from "./harness.ts";

// The skills Grok Build would offer a session in a folder, from its own discovery (`_x.ai/skills/list`):
// the user's, the project's, plugins' and the ones it borrows from other harnesses. Each is invoked by
// its id, which is also its slash command.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (record: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  for (const key of keys) if (typeof record[key] === "string" && record[key] !== "") return record[key];
  return undefined;
};

/** A `_x.ai/skills/list` answer as Cerium's skills, disabled ones left out. */
export const skillsFromList = (answer: unknown): ReadonlyArray<SkillInfo> => {
  const skills = isRecord(answer) && Array.isArray(answer["skills"]) ? answer["skills"] : [];
  return skills.flatMap((skill): ReadonlyArray<SkillInfo> => {
    if (!isRecord(skill) || skill["enabled"] === false) return [];
    const name = text(skill, "id", "name");
    if (name === undefined) return [];
    const description = text(skill, "description");
    const path = text(skill, "path");
    return [{ name, ...(description ? { description } : {}), ...(path ? { path } : {}) }];
  });
};

export const listGrokSkills = (executablePath: string, cwd: string) =>
  withAcpAgent(grokHarness, executablePath, "probe", (agent) =>
    grokExtension(agent.connection, "skills/list", { cwd, refresh: true }).pipe(
      Effect.map(skillsFromList),
      Effect.mapError(
        (cause) =>
          new HarnessFailure({
            provider: "grok",
            message: `Grok Build couldn't list its skills: ${cause.message}`,
            cause,
          }),
      ),
    ),
  );
