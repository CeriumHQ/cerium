import type { SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

// The skills Antigravity offers a session in a folder: `SKILL.md` folders in the documented places
// (antigravity.google/docs/skills): the workspace's `.agents/skills`, then the user's
// `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills` and `~/.gemini/skills`. Each becomes a
// `/<name>` command in a run.

export const skillFolders = (cwd: string, geminiHome: string): ReadonlyArray<string> => [
  join(cwd, ".agents", "skills"),
  join(geminiHome, "config", "skills"),
  join(geminiHome, "antigravity-cli", "skills"),
  join(geminiHome, "skills"),
];

/** A SKILL.md's name and description, from its frontmatter. */
export const skillOf = (text: string, folderName: string, path: string): SkillInfo | undefined => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  let meta: unknown;
  try {
    meta = frontmatter === undefined ? {} : parse(frontmatter);
  } catch {
    meta = {};
  }
  const record = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  const name =
    typeof record["name"] === "string" && record["name"].trim() !== "" ? record["name"].trim() : folderName;
  if (name === "") return undefined;
  const description = typeof record["description"] === "string" ? record["description"].trim() : "";
  return { name, ...(description ? { description } : {}), path };
};

export const listAntigravitySkills = (cwd: string, geminiHome: string) =>
  Effect.promise(async () => {
    const skills: Array<SkillInfo> = [];
    for (const folder of skillFolders(cwd, geminiHome)) {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(folder, entry.name, "SKILL.md");
        const text = await readFile(path, "utf8").catch(() => undefined);
        const skill = text === undefined ? undefined : skillOf(text, entry.name, path);
        // The first place a name appears wins, as the workspace's skills come first.
        if (skill !== undefined && !skills.some((each) => each.name === skill.name)) skills.push(skill);
      }
    }
    return skills as ReadonlyArray<SkillInfo>;
  });
