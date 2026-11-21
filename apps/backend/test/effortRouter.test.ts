import { assert, describe, expect, it } from "@effect/vitest";
import { VaultError } from "@cerium/account";
import { UserSettings } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

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

describe("saving and removing the key", () => {
  const decision = {
    answers: {
      effort: { probabilities: { "0": 1 }, confidence: 0.9 },
      task: { choice: "acknowledge" },
      context: { noul: 0.9 },
    },
  };
  const withRouter = (status: number, body: unknown) => {
    let stored: string | undefined;
    return EffortRouter.layer.pipe(
      Layer.provideMerge(UserSettings.layer),
      Layer.provide(
        Layer.succeed(EffortRouterKey, {
          read: Effect.sync(() => stored),
          write: (key) => Effect.sync(() => void (stored = key)),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
          ),
        ),
      ),
      Layer.provide(Store.layer({ filename: ":memory:" })),
    );
  };

  it.effect("turns the router on once a key checks out, and off when it is removed", () =>
    Effect.gen(function* () {
      const router = yield* EffortRouter;
      const settings = yield* UserSettings;
      assert.isFalse((yield* settings.get).effortRouter.enabled);
      assert.strictEqual((yield* router.save("  sk-or-test-abcd  ")).key?.last4, "abcd");
      assert.isTrue((yield* settings.get).effortRouter.enabled);
      assert.isTrue(yield* router.decider.ready);
      assert.isUndefined((yield* router.remove).key);
      assert.isFalse((yield* settings.get).effortRouter.enabled);
      assert.isFalse(yield* router.decider.ready);
    }).pipe(Effect.provide(withRouter(200, decision))),
  );

  it.effect("keeps neither the key nor the switch when OpenRouter refuses it", () =>
    Effect.gen(function* () {
      const router = yield* EffortRouter;
      const settings = yield* UserSettings;
      const error = yield* Effect.flip(router.save("sk-or-bad"));
      assert.strictEqual(error.message, "OpenRouter didn't accept the key.");
      assert.isUndefined((yield* router.status).key);
      assert.isFalse((yield* settings.get).effortRouter.enabled);
    }).pipe(Effect.provide(withRouter(401, { error: { message: "No auth credentials found" } }))),
  );

  it.effect("asks for a key rather than checking a blank one", () =>
    Effect.gen(function* () {
      const router = yield* EffortRouter;
      const error = yield* Effect.flip(router.save("   "));
      assert.strictEqual(error.message, "Paste an OpenRouter key.");
    }).pipe(Effect.provide(withRouter(200, decision))),
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
