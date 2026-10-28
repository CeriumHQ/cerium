import { describe, expect, it } from "vite-plus/test";

import { GIT_REPOSITORY_VARIABLES } from "../../apps/backend/src/gitRepositoryVariables.ts";

describe("test setup", () => {
  it("leaves git no repository to inherit, wherever the tests were started from", () => {
    expect(process.env["GIT_DIR"]).toBeUndefined();
    expect(GIT_REPOSITORY_VARIABLES.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });
});
