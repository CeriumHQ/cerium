import { ErrorCode, record, string, type AcpConnection } from "@cerium/acp";
import type { SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";
import { resolve } from "node:path";

import { failure } from "./manifest.ts";

/** Lists the skills Devin discovers, including enabled plugins and compatibility folders. */
export const listDevinSkills = Effect.fn("Devin.listSkills")(function* (
  acp: AcpConnection,
  cwd: string,
  fallback: () => Effect.Effect<ReadonlyArray<SkillInfo>>,
) {
  const method = "_cognition.ai/skills/list";
  const answer = yield* acp.query(method, { cwd: resolve(cwd) }).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error._tag === "AcpError" && error.code === ErrorCode.methodNotFound,
      () => Effect.succeedNone,
    ),
    Effect.mapError((error) => acp.refused(method)(error)),
  );
  if (answer._tag === "None") return yield* fallback();
  const skills = record(answer.value)?.["skills"];
  if (!Array.isArray(skills)) return yield* failure("Devin returned an invalid skill list");

  const listed = new Map<string, SkillInfo>();
  for (const item of skills) {
    const entry = record(item);
    const name = string(entry?.["name"]);
    if (!name || entry?.["userInvocable"] === false || listed.has(name)) continue;
    const description = string(entry?.["description"]);
    const path = string(entry?.["path"]);
    listed.set(name, {
      name,
      ...(description === undefined ? {} : { description }),
      ...(path?.endsWith("SKILL.md") ? { path } : {}),
    });
  }
  return [...listed.values()].sort((a, b) => a.name.localeCompare(b.name));
});
