import { HarnessFailure } from "@cerium/harness";
import type { SkillInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { call, type OpenCodeClient } from "./host.ts";

/** The subset of `skill.list` Cerium reads; each skill's body (`content`) is left alone. */
const Skills = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      path: Schema.String,
    }),
  ),
});
const decodeSkills = Schema.decodeUnknownEffect(Skills);

/** The skills OpenCode would offer a session in `directory`: the user's, the project's and plugins'. */
export const listOpenCodeSkills = Effect.fn("OpenCodeAdapter.listSkills")(function* (
  client: OpenCodeClient,
  directory: string,
) {
  const listed = yield* call("list its skills", (signal) =>
    client.skill.list({ location: { directory } }, { signal }),
  );
  const { data } = yield* decodeSkills(listed).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessFailure({ provider: "opencode", message: "Unexpected `skill.list` response", cause }),
    ),
  );
  return data.flatMap((skill): ReadonlyArray<SkillInfo> =>
    skill.name === ""
      ? []
      : [
          {
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            ...(skill.path ? { path: skill.path } : {}),
          },
        ],
  );
});
