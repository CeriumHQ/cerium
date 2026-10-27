import {
  DECISION_INSTRUCTIONS,
  DIFFICULTY_LEVELS,
  EffortDecider,
  EffortDecisionError,
  LEVEL_GUIDE,
  UserSettings,
  supportedProbabilities,
  validProbabilities,
  type EffortAnswer,
  type EffortQuestion,
} from "@cerium/orchestrator";
import type { EffortRouterStatus } from "@cerium/rpc";
import { Store } from "@cerium/store";
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { EffortRouterKey } from "./vault.ts";
import { effortSpend } from "./effortSpend.ts";

// The effort router's decision model: Jev, by TypeSafe, through OpenRouter's Decisions API and the
// key the user gave Cerium. The key goes to OpenRouter and nowhere else: never into a log, an event
// or an agent's prompt, and the UI only ever gets its last four characters back.

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** Picked over OpenAI's Decisions for its price: $0.042 per million input tokens, output free. */
const DECISION_MODEL = "typesafe/jev-1.13";

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const ScoreAnswer = Schema.Struct({
  probabilities: Schema.Record(Schema.String, Probability),
  confidence: Probability,
});
export const DecisionResponse = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  answers: Schema.Struct({
    effort: ScoreAnswer,
    task: Schema.Struct({
      choice: Schema.Literals(["acknowledge", "execute", "investigate", "design", "verify"]),
    }),
    context: Schema.Struct({ noul: Probability }),
  }),
  usage: Schema.optionalKey(
    Schema.Struct({ cost: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }),
  ),
});
const ErrorResponse = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

/** Why OpenRouter refused, in words for the user. */
const refusal = (status: number, message: string | undefined) =>
  status === 401
    ? "OpenRouter didn't accept the key."
    : status === 402
      ? "The OpenRouter account has no credit left."
      : status === 429
        ? "OpenRouter is limiting requests for now."
        : `OpenRouter answered ${status}${message === undefined ? "" : `: ${message}`}.`;

/** A question that costs next to nothing, asked to check a key before keeping it. */
const KEY_CHECK: EffortQuestion = {
  levels: ["low", "high"],
  state: { turn: { from: "user", text: "Reply with OK." }, recent: [] },
};

const last4 = (key: string) => key.slice(-4);

export class EffortRouter extends Context.Service<
  EffortRouter,
  {
    readonly decider: EffortDecider["Service"];
    readonly status: Effect.Effect<EffortRouterStatus, EffortDecisionError>;
    /** Checks the key with one decision, then keeps it. */
    save(key: string): Effect.Effect<EffortRouterStatus, EffortDecisionError>;
    /** Forgets the key and turns the router off. */
    readonly remove: Effect.Effect<EffortRouterStatus, EffortDecisionError>;
  }
>()("cerium/backend/EffortRouter") {
  /** Requires an `HttpClient`, the `EffortRouterKey`, the `Store` and `UserSettings`. */
  static readonly layer = Layer.effect(
    EffortRouter,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const vault = yield* EffortRouterKey;
      const store = yield* Store;
      const settings = yield* UserSettings;
      const failed = (message: string) => () => new EffortDecisionError({ message });

      // Read from the vault once and kept in memory, so a turn doesn't wait on the shell for it.
      const loaded = yield* Ref.make<Option.Option<string | undefined>>(Option.none());
      const currentKey = Effect.gen(function* () {
        const known = yield* Ref.get(loaded);
        if (Option.isSome(known)) return known.value;
        const key = yield* vault.read.pipe(Effect.orElseSucceed(() => undefined));
        yield* Ref.set(loaded, Option.some(key));
        return key;
      });

      const ask = (key: string, question: EffortQuestion) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(DECISIONS_URL).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${key}`),
            HttpClientRequest.setHeader("x-title", "Cerium"),
            HttpClientRequest.bodyJson({
              model: DECISION_MODEL,
              state: question.state,
              questions: {
                effort: {
                  type: "score",
                  instructions: DECISION_INSTRUCTIONS,
                  criteria: DIFFICULTY_LEVELS.map((level) => LEVEL_GUIDE[level]),
                },
                task: {
                  type: "choice",
                  instructions:
                    "What work does the next turn require, resolving follow-ups using task, pending and recent?",
                  criteria: {
                    acknowledge: "Only acknowledge or repeat; no execution requested",
                    execute: "Carry out a specified implementation or routine procedure",
                    investigate: "Find a cause or gather evidence to answer an unresolved question",
                    design: "Choose an approach among alternatives or reconcile requirements",
                    verify: "Check an existing result against requirements",
                  },
                },
                context: {
                  type: "noul",
                  instructions:
                    "Does the supplied state identify what work the next turn requires? Short approvals need an identifiable antecedent; missing file contents alone do not make the task unclear.",
                },
              },
            }),
            Effect.mapError(failed("Couldn't write the question for OpenRouter.")),
          );
          const response = yield* client
            .execute(request)
            .pipe(Effect.mapError(failed("Couldn't reach OpenRouter.")));
          const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
          if (response.status !== 200) {
            const message = Schema.decodeUnknownOption(ErrorResponse)(body).pipe(
              Option.map((error) => error.error.message),
              Option.getOrUndefined,
            );
            return yield* new EffortDecisionError({ message: refusal(response.status, message) });
          }
          const decision = yield* Schema.decodeUnknownEffect(DecisionResponse)(body).pipe(
            Effect.mapError(failed("OpenRouter's answer wasn't a decision.")),
          );
          const { probabilities, confidence } = decision.answers.effort;
          const distribution = DIFFICULTY_LEVELS.map((_, index) => probabilities[String(index)] ?? 0);
          if (
            Object.keys(probabilities).some((key) => !DIFFICULTY_LEVELS.some((_, i) => String(i) === key)) ||
            !validProbabilities(distribution, DIFFICULTY_LEVELS.length)
          )
            return yield* new EffortDecisionError({
              message: "The router returned an invalid probability distribution.",
            });
          const cost = decision.usage?.cost;
          return {
            probabilities: supportedProbabilities(question.levels, distribution),
            confidence,
            decisionModel: decision.model ?? DECISION_MODEL,
            taskType: decision.answers.task.choice,
            contextSufficient: decision.answers.context.noul,
            ...(cost === undefined ? {} : { costUsd: cost }),
          } satisfies EffortAnswer;
        });

      const decider: EffortDecider["Service"] = {
        ready: currentKey.pipe(Effect.map((key) => key !== undefined)),
        decide: (question) =>
          Effect.gen(function* () {
            const key = yield* currentKey;
            if (key === undefined)
              return yield* new EffortDecisionError({ message: "No OpenRouter key is saved." });
            return yield* ask(key, question);
          }),
      };

      const status = Effect.gen(function* () {
        const key = yield* currentKey;
        const routed = yield* store
          .listEventsByTag("EffortRouted")
          .pipe(Effect.mapError(failed("Couldn't read what the router spent.")));
        const spend = effortSpend(
          routed.flatMap((event) =>
            event.payload._tag === "EffortRouted"
              ? [{ at: event.at, costUsd: event.payload.costUsd ?? 0 }]
              : [],
          ),
          yield* Clock.currentTimeMillis,
        );
        return { ...(key === undefined ? {} : { key: { last4: last4(key) } }), ...spend };
      });

      const save = (given: string) =>
        Effect.gen(function* () {
          const key = given.trim();
          if (key === "") return yield* new EffortDecisionError({ message: "Paste an OpenRouter key." });
          yield* ask(key, KEY_CHECK);
          yield* vault
            .write(key)
            .pipe(Effect.mapError((error) => new EffortDecisionError({ message: error.message })));
          yield* Ref.set(loaded, Option.some(key));
          return yield* status;
        });

      const remove = Effect.gen(function* () {
        yield* vault
          .write(undefined)
          .pipe(Effect.mapError((error) => new EffortDecisionError({ message: error.message })));
        yield* Ref.set(loaded, Option.some(undefined));
        const { effortRouter } = yield* settings.get;
        if (effortRouter.enabled) {
          yield* settings
            .update({ effortRouter: { ...effortRouter, enabled: false } })
            .pipe(Effect.mapError((error) => new EffortDecisionError({ message: error.message })));
        }
        return yield* status;
      });

      return EffortRouter.of({ decider, status, save, remove });
    }),
  );

  /** The orchestrator's decision model, from the router. */
  static readonly decider = Layer.effect(
    EffortDecider,
    Effect.gen(function* () {
      return (yield* EffortRouter).decider;
    }),
  );
}
