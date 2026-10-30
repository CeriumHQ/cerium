import { makeFakeAdapter } from "@cerium/harness/testing";
import { applyOverviewUpdate, type ThreadOverview } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { Orchestrator } from "../src/index.ts";
import { testLayer } from "./fakes.ts";

describe("thread overview invalidation", () => {
  it.live(
    "publishes metadata and approval edits without transcript events, but ignores stored tool events",
    () => {
      const fake = makeFakeAdapter("claude");
      return Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator,
            store = yield* Store;
          let current: ReadonlyArray<ThreadOverview> = [];
          let patches = 0;
          const ready = yield* Deferred.make<void>();
          yield* orchestrator.watchThreadOverviews.pipe(
            Stream.runForEach((update) =>
              Effect.gen(function* () {
                current = applyOverviewUpdate(current, update);
                patches++;
                yield* Deferred.succeed(ready, undefined);
              }),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          const until = Effect.fn("waitForOverview")(function* (matches: () => boolean) {
            for (let attempt = 0; attempt < 200; attempt++) {
              if (matches()) return;
              yield* Effect.sleep("5 millis");
            }
            return yield* Effect.die(new Error("Overview did not change"));
          });
          const { thread, lead } = yield* orchestrator.createThread({
            title: "Original",
            mode: "work",
            cwd: ".",
            lead: { provider: "claude", model: "opus", access: "ask" },
          });
          const row = () => current.find((value) => value.thread.id === thread.id);
          yield* until(() => row() !== undefined);
          yield* orchestrator.renameThread(thread.id, "Renamed elsewhere");
          yield* orchestrator.setThreadLater(thread.id, 123456);
          yield* until(
            () => row()?.thread.title === "Renamed elsewhere" && row()?.thread.laterUntil === 123456,
          );
          const { requestId } = yield* orchestrator.askUser(lead.id, [
            { question: "Choose", options: [], multiSelect: false, allowOther: true },
          ]);
          yield* until(() => row()?.awaitingApproval === true);
          yield* orchestrator.answerQuestion(lead.id, requestId, { outcome: "dismissed" });
          yield* until(() => row()?.awaitingApproval === false);
          const before = patches;
          yield* store.appendEvents([
            {
              id: `${lead.id}:1000` as never,
              agentId: lead.id,
              threadId: thread.id,
              sequence: 1000,
              at: 1000,
              payload: { _tag: "ToolCallCompleted", callId: "irrelevant", output: "done", isError: false },
            },
          ]);
          yield* Effect.sleep("300 millis");
          assert.strictEqual(patches, before);
          yield* orchestrator.setThreadArchived(thread.id, true);
          yield* until(() => row()?.thread.archivedAt !== undefined);
          assert.isDefined(row());
          yield* orchestrator.deleteThread(thread.id);
          yield* until(() => row() === undefined);
        }),
      ).pipe(Effect.provide(testLayer([fake.adapter])));
    },
  );
});
