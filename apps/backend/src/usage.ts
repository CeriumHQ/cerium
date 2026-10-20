import { HarnessFailure, type HarnessAdapter } from "@cerium/harness";
import type { ProviderId, ProviderUsage } from "@cerium/protocol";
import { Clock, Duration, Effect, Option } from "effect";

/** How long a harness gets to report its usage before the page says it didn't. */
const USAGE_TIMEOUT = Duration.seconds(30);

/**
 * Every subscribed harness's usage, read from each at once, in adapter order. A harness that isn't
 * usable or has no subscription is left out; one whose read fails says why.
 */
export const subscriptionUsage = (adapters: ReadonlyMap<ProviderId, HarnessAdapter>) =>
  Effect.forEach(
    [...adapters.values()],
    ({ provider, usage }): Effect.Effect<ReadonlyArray<ProviderUsage>> =>
      usage === undefined
        ? Effect.succeed([])
        : usage.pipe(
            Effect.timeoutOrElse({
              duration: USAGE_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new HarnessFailure({
                    provider,
                    message: "The harness didn't report its usage in time.",
                    cause: null,
                  }),
                ),
            }),
            Effect.flatMap((report) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((checkedAt): ReadonlyArray<ProviderUsage> =>
                  Option.isNone(report) ? [] : [{ _tag: "Subscribed", provider, ...report.value, checkedAt }],
                ),
              ),
            ),
            Effect.catchTags({
              HarnessUnavailable: () => Effect.succeed([]),
              HarnessFailure: (error) =>
                Effect.succeed([{ _tag: "UsageUnreadable" as const, provider, message: error.message }]),
            }),
          ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((each) => each.flat()));
