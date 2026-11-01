import type { SkillInfo } from "@cerium/protocol";
import { Effect, FileSystem } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

/** Native discovery order; reads skill definitions only, never Antigravity's credential directory. */
export const listAntigravitySkills = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["GEMINI_HOME"] || join(homedir(), ".gemini");
    const roots = [
      join(cwd, ".gemini", "skills"),
      join(cwd, ".agents", "skills"),
      join(cwd, ".agent", "skills"),
      join(home, "config", "skills"),
      join(home, "antigravity-cli", "skills"),
    ];
    const found = new Map<string, SkillInfo>();
    for (const root of roots) {
      const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as Array<string>));
      for (const entry of entries) {
        const path = join(root, entry, "SKILL.md");
        const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
        if (!text) continue;
        const name = /^name:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim() || entry;
        if (found.has(name)) continue;
        const description = /^description:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim();
        found.set(name, { name, path, ...(description ? { description } : {}) });
      }
    }
    return [...found.values()];
  });
