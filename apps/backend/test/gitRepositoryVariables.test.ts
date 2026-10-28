import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

import { forgetGitRepository, GIT_REPOSITORY_VARIABLES } from "../src/gitRepositoryVariables.ts";

describe("git's repository variables", () => {
  it("are every one the installed git lists", () => {
    const listed = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter((name) => name !== "");
    expect(listed).toContain("GIT_DIR");
    expect(GIT_REPOSITORY_VARIABLES).toEqual(expect.arrayContaining(listed));
  });

  it("are forgotten, and git's other settings kept", () => {
    const env = {
      GIT_DIR: "C:/repo/.git/worktrees/x",
      GIT_WORK_TREE: "C:/repo",
      GIT_INDEX_FILE: "C:/repo/.git/worktrees/x/index",
      GIT_CONFIG_COUNT: "1",
      GIT_SSH_COMMAND: "ssh",
      GIT_TRACE: "1",
      PATH: "/bin",
    };
    forgetGitRepository(env);
    expect(env).toEqual({ GIT_SSH_COMMAND: "ssh", GIT_TRACE: "1", PATH: "/bin" });
  });
});
