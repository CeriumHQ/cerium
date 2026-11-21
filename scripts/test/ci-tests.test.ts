import { assert, describe, it } from "vite-plus/test";

import { selectedTests } from "../ci-tests.ts";

describe("PR test selection", () => {
  it("runs each changed test and the relay suite when Worker code changes", () => {
    const paths = ["apps/relay/src/index.ts", "apps/relay/src/http.ts", "packages/store/test/store.test.ts"];
    assert.deepEqual(selectedTests(paths.map((path) => `M\0${path}\0`).join("")), [
      "apps/relay/test/",
      "packages/store/test/store.test.ts",
    ]);
  });

  it("uses the full suite if any path is shared, removed, unrecognized or malformed", () => {
    for (const record of [
      "M\0bun.lock\0",
      "M\0apps/relay/migrations/0001.sql\0",
      "D\0apps/relay/test/sync.test.ts\0",
      "M\0packages/protocol/src/schema.ts\0",
      "M\0scripts/test-setup.ts\0",
      "M\0apps/relay/test/bad\nname.test.ts\0",
      "M\0unfinished",
    ]) {
      assert.deepEqual(selectedTests(`A\0apps/relay/test/limits.test.ts\0${record}`), []);
    }
  });
});
