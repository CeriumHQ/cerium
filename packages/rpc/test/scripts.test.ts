import { assert, describe, it } from "@effect/vitest";

import { actionListProblem, actionNameProblem } from "../src/scripts.ts";

// What a project's actions may be called: names label menu rows and terminal tabs, and a name must
// tell its action apart from the others and from the project's own scripts.

describe("actionNameProblem", () => {
  it("accepts a plain name, spaces and case included", () => {
    assert.isUndefined(actionNameProblem("Run migrations", ["Test"]));
    assert.isUndefined(actionNameProblem("  lint  ", []));
  });

  it("asks for a name", () => {
    assert.strictEqual(actionNameProblem("   ", []), "Give it a name.");
  });

  it("refuses the names of the project's own scripts, whatever their case", () => {
    for (const name of ["Setup", "run", "TEARDOWN"]) {
      assert.match(actionNameProblem(name, []) ?? "", /script of its own/);
    }
  });

  it("refuses a name another action has, ignoring case and the spaces around it", () => {
    assert.strictEqual(actionNameProblem("test", [" Test "]), "That name is taken.");
  });

  it("refuses control characters", () => {
    assert.strictEqual(actionNameProblem("a\nb", []), "No control characters.");
  });
});

describe("actionListProblem", () => {
  it("is silent for a list of distinct names", () => {
    assert.isUndefined(actionListProblem([{ name: "Test" }, { name: "Lint" }]));
    assert.isUndefined(actionListProblem([]));
  });

  it("names the first action that can't be told apart from the ones before it", () => {
    assert.strictEqual(
      actionListProblem([{ name: "Test" }, { name: "Lint" }, { name: "test" }]),
      "test: That name is taken.",
    );
  });
});
