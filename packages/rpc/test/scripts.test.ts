import { assert, describe, it } from "@effect/vitest";

import { actionListProblem, actionNameProblem } from "../src/scripts.ts";

// What a project's actions may be called: names label menu rows and terminal tabs, and a name must
// tell its action apart from the others and from the project's own scripts.

describe("actionNameProblem", () => {
  it("accepts distinct names and rejects empty, reserved, duplicate or control-character names", () => {
    assert.isUndefined(actionNameProblem("Run migrations", ["Test"]));
    assert.isUndefined(actionNameProblem("  lint  ", []));
    assert.strictEqual(actionNameProblem("   ", []), "Give it a name.");
    for (const name of ["Setup", "run", "TEARDOWN"]) {
      assert.match(actionNameProblem(name, []) ?? "", /script of its own/);
    }
    assert.strictEqual(actionNameProblem("test", [" Test "]), "That name is taken.");
    assert.strictEqual(actionNameProblem("a\nb", []), "No control characters.");
  });
});

describe("actionListProblem", () => {
  it("accepts distinct names and identifies the first duplicate", () => {
    assert.isUndefined(actionListProblem([{ name: "Test" }, { name: "Lint" }]));
    assert.isUndefined(actionListProblem([]));
    assert.strictEqual(
      actionListProblem([{ name: "Test" }, { name: "Lint" }, { name: "test" }]),
      "test: That name is taken.",
    );
  });
});
