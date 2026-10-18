import type { SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";

import { inspectClaude } from "./models.ts";

/**
 * The skills and custom commands Claude Code offers a session in `cwd`: the user's, the project's and
 * plugins'. Claude Code's own commands (`/compact`, `/usage`, …) are left out.
 */
export const listClaudeSkills = Effect.fn("ClaudeAdapter.listSkills")(function* (
  executablePath: string,
  cwd: string,
) {
  const commands = yield* inspectClaude(executablePath, cwd, "Could not list Claude skills", (session) =>
    session.supportedCommands(),
  );
  return commands
    .filter((command) => command.builtin !== true)
    .map((command): SkillInfo => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
    }));
});
