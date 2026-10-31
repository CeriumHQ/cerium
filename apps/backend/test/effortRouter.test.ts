import { assert, describe, expect, it } from "@effect/vitest";
import { VaultError } from "@cerium/account";
import { UserSettings } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";

import { DecisionResponse, EffortRouter } from "../src/effortRouter.ts";
import { EffortRouterKey } from "../src/vault.ts";

it.effect("retries a failed vault read and caches the later successful read", () => {
  let reads = 0;
  return Effect.gen(function* () {
    const router = yield* EffortRouter;
    assert.isFalse(yield* router.decider.ready);
    assert.isTrue(yield* router.decider.ready);
    assert.strictEqual((yield* router.status).key?.last4, "1234");
    assert.strictEqual(reads, 2);
  }).pipe(
    Effect.provide(
      EffortRouter.layer.pipe(
        Layer.provide(
          Layer.succeed(EffortRouterKey, {
            read: Effect.suspend(() =>
              ++reads === 1
                ? Effect.fail(new VaultError({ message: "Shell timed out." }))
                : Effect.succeed("test-key-1234"),
            ),
            write: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unused")),
          ),
        ),
        Layer.provide(UserSettings.layer),
        Layer.provide(Store.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

describe("decision wire validation", () => {
  const response = (probability: number, confidence = 0.8, context = 0.9) => ({
    answers: {
      effort: { probabilities: { "0": probability }, confidence },
      task: { choice: "investigate" },
      context: { noul: context },
    },
  });
  it("accepts sparse distributions and independent task/context judgments", () => {
    expect(Option.isSome(Schema.decodeUnknownOption(DecisionResponse)(response(1)))).toBe(true);
  });
  it("rejects negative, out-of-range and nonfinite probabilities and confidence", () => {
    for (const p of [-0.1, 1.1, NaN, Infinity]) {
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(p)))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(1, p)))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(DecisionResponse)(response(1, 0.8, p)))).toBe(true);
    }
  });
});
