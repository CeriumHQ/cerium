import { HarnessFailure } from "@cerium/harness";
import type { HubSkill, SkillInfo } from "@cerium/protocol";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const museConfigFolder = () =>
  join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "muse");

const Skill = Schema.Struct({
  id: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scope: Schema.Literals(["project", "user", "bundled", "plugin"]),
  path: Schema.NonEmptyString,
  activation: Schema.Literals(["on", "off", "user-invocable-only"]),
});
type MuseSkill = typeof Skill.Type;

const decodeSkills = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      skills: Schema.Array(Skill),
    }),
  ),
);

export const runMuseSkills = (executable: string, project: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        executable,
        ["skills", ...args, "--workspace", project, "--trust-workspace", "--json"],
        { cwd: project, stderr: "ignore" },
      ),
    );
    const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    const status = yield* child.exitCode;
    if (status !== 0)
      return yield* new HarnessFailure({
        provider: "muse",
        message: `Muse Code could not ${args[0]} skills (exit code ${status})`,
        cause: undefined,
      });
    return output;
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      cause instanceof HarnessFailure
        ? cause
        : new HarnessFailure({
            provider: "muse",
            message: `Muse Code could not ${args[0]} skills`,
            cause,
          }),
    ),
  );

export const readMuseSkills = (executable: string, project: string) =>
  runMuseSkills(executable, project, ["list"]).pipe(
    Effect.flatMap((stdout) => decodeSkills(stdout)),
    Effect.map(({ skills }) => skills),
    Effect.catchTag(
      "SchemaError",
      (cause) =>
        new HarnessFailure({
          provider: "muse",
          message: "Muse Code returned an invalid skill list",
          cause,
        }),
    ),
  );

const skillPath = (project: string, path: string) => {
  if (path.startsWith("$HOME/")) return join(homedir(), path.slice("$HOME/".length));
  if (path.startsWith("$CONFIG_DIR/")) return join(museConfigFolder(), path.slice("$CONFIG_DIR/".length));
  return resolve(project, path);
};

export const toHubSkill = (project: string, skill: MuseSkill): HubSkill => ({
  name: skill.id,
  ...(skill.description ? { description: skill.description } : {}),
  scope: skill.scope === "plugin" ? "bundled" : skill.scope,
  path: skill.path.startsWith("bundled://")
    ? skill.path.slice(0, skill.path.lastIndexOf("/"))
    : dirname(skillPath(project, skill.path)),
  enabled: skill.activation !== "off",
});

export const listMuseSkills = (executable: string, project: string) =>
  readMuseSkills(executable, project).pipe(
    Effect.map((skills) =>
      skills
        .filter(({ activation }) => activation !== "off")
        .map((skill): SkillInfo => ({
          name: skill.id.replace(/^bundled:/, ""),
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.path.startsWith("bundled://") ? {} : { path: skillPath(project, skill.path) }),
        })),
    ),
  );
