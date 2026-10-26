import { makeFakeAdapter } from "@cerium/harness/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { Orchestrator } from "../src/index.ts";
import { testLayer } from "./fakes.ts";

describe("Orchestrator tasks mirror", () => {
  it.live("reads what syncUserTasks enters, and what an agent added", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      yield* orchestrator.syncUserTasks([
        { id: "one", updatedAt: Date.now(), task: { title: "Synced", createdAt: 1 } },
      ]);
      assert.strictEqual((yield* orchestrator.userTasks).length, 1);
      const { lead } = yield* orchestrator.createThread({
        title: "Mirror",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      yield* orchestrator.addUserTask(lead.id, { title: "Read the lockfile" });
      assert.strictEqual((yield* orchestrator.userTasks).length, 2);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
