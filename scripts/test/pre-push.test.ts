import { describe, expect, it } from "vite-plus/test";

import { pushedRanges, withoutRepository } from "../pre-push.ts";

const sha = (digit: string) => digit.repeat(40);

describe("pre-push", () => {
  it("checks what each pushed ref adds, and nothing for a deleted one", () => {
    const input = [
      `refs/heads/main ${sha("a")} refs/heads/main ${sha("b")}`,
      `refs/heads/new ${sha("c")} refs/heads/new ${sha("0")}`,
      `(delete) ${sha("0")} refs/heads/old ${sha("d")}`,
      "",
    ].join("\n");
    expect(pushedRanges(input)).toEqual([
      { base: sha("b"), head: sha("a") },
      { base: sha("0"), head: sha("c") },
    ]);
    expect(pushedRanges("")).toEqual([]);
  });

  it("runs the checks outside the repository git ran the hook for", () => {
    const env = {
      GIT_DIR: "C:/repo/.git/worktrees/x",
      GIT_INDEX_FILE: "index",
      GIT_SSH_COMMAND: "ssh",
      PATH: "/bin",
    };
    expect(withoutRepository(env, ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"])).toEqual({
      GIT_SSH_COMMAND: "ssh",
      PATH: "/bin",
    });
  });
});
