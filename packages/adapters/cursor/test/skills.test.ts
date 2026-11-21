import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "vite-plus/test";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

import { listCursorSkills, readCursorSkills } from "../src/skills.ts";

const skill = (folder: string, name: string, description: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(folder, name), { recursive: true });
    yield* fs.writeFileString(
      join(folder, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
    );
  });

/** Runs with a home folder of its own, so the user's real skills stay out of it. */
const withHome = <A, E, R>(use: (home: string, project: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-cursor-skills-" });
    const home = join(root, "home");
    const project = join(root, "project");
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(project);
    return yield* use(home, project);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Cursor skills", () => {
  it("reads the folders the SDK scans, the user's first, then the project's and Cursor's own", () =>
    Effect.runPromise(
      withHome((home, project) =>
        Effect.gen(function* () {
          yield* skill(join(home, ".cursor", "skills"), "review", "Review a diff");
          yield* skill(join(home, ".agents", "skills"), "deploy", "Ship it");
          yield* skill(join(project, ".cursor", "skills"), "local", "Project skill");
          yield* skill(join(project, ".agents", "skills"), "review", "Shadowed by the user's");
          yield* skill(join(home, ".cursor", "skills-cursor"), "create-rule", "Cursor's own");
          // Third-party folders load only when Cursor's setting allows them.
          yield* skill(join(home, ".claude", "skills"), "claude-only", "Not offered");

          const skills = yield* readCursorSkills(project, home);
          expect(skills.map(({ name, scope }) => `${scope}:${name}`)).toEqual([
            "bundled:create-rule",
            "user:deploy",
            "project:local",
            "user:review",
          ]);
          expect(yield* listCursorSkills(project, home)).toContainEqual({
            name: "review",
            description: "Review a diff",
            path: join(home, ".cursor", "skills", "review", "SKILL.md"),
          });
        }),
      ),
    ));

  it("finds none where no folder exists", () =>
    Effect.runPromise(
      withHome((home, project) =>
        Effect.map(listCursorSkills(project, home), (skills) => expect(skills).toEqual([])),
      ),
    ));
});
