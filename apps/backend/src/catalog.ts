import { HarnessFailure, HarnessUnavailable, type HarnessAdapter } from "@cerium/harness";
import { Adapters, Catalog, UserSettings, type CatalogEntry } from "@cerium/orchestrator";
import {
  rosterMembers,
  type HarnessStatus,
  type ModelInfo,
  type ProviderId,
  type RosterMember,
} from "@cerium/protocol";
import { Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope } from "effect";

/** How long each harness may take to list its models. */
const LIST_TIMEOUT = "20 seconds";

/** How long to reuse a completed listing, including an empty list or an unavailable harness. */
const FRESH_FOR_MS = Duration.toMillis(Duration.minutes(1));

/**
 * The roster's models as leads know them: by id, or `provider/id` where two harnesses list the same id,
 * each with its rank among its harness's models and its speed.
 */
export const catalogEntries = (members: ReadonlyArray<RosterMember>): ReadonlyArray<CatalogEntry> =>
  members.map(({ model, use, priority, speed }): CatalogEntry => ({
    alias: members.some((other) => other.model !== model && other.model.id === model.id)
      ? `${model.provider}/${model.id}`
      : model.id,
    provider: model.provider,
    model: model.id,
    ...(speed ? { speed } : {}),
    description: use,
    priority,
  }));

type ModelList = ReadonlyArray<ModelInfo>;
type ListingResult = Exit.Exit<ModelList, HarnessUnavailable | HarnessFailure>;

interface Listing {
  readonly done: Deferred.Deferred<ListingResult | undefined>;
  expiresAt: number;
}

interface HarnessModels {
  readonly adapter: HarnessAdapter;
  models: ModelList;
  listing?: Listing;
  status?: string;
}

/** One listing per harness, shared by startup, the catalog, and the UI. */
export class OfferedModels extends Context.Service<
  OfferedModels,
  {
    /** Waits for startup discovery. Later reads return the last lists and refresh expired ones in the background. */
    readonly all: Effect.Effect<ModelList>;
    /** Returns the fresh list for one harness, waiting for a listing if necessary. */
    list(provider: ProviderId): Effect.Effect<ModelList, HarnessUnavailable | HarnessFailure>;
    /** Drops models from before a sign-in or update and starts a new listing. */
    invalidate(provider: ProviderId): Effect.Effect<void>;
    /** Refreshes models when a probe sees a different install or sign-in state. */
    observe(status: HarnessStatus): Effect.Effect<void>;
  }
>()("cerium/backend/OfferedModels") {
  static readonly layer = Layer.effect(
    OfferedModels,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const scope = yield* Scope.Scope;
      const harnesses = new Map<ProviderId, HarnessModels>(
        [...adapters].map(([provider, adapter]) => [provider, { adapter, models: [] }]),
      );
      const ordered = [...harnesses.values()];

      const ensureListing = (harness: HarnessModels) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (harness.listing !== undefined && now < harness.listing.expiresAt) return harness.listing;

          const { adapter } = harness;
          const listing: Listing = { done: Deferred.makeUnsafe(), expiresAt: Infinity };
          harness.listing = listing;
          const discover = adapter.listModels.pipe(
            Effect.timeoutOrElse({
              duration: LIST_TIMEOUT,
              orElse: () =>
                new HarnessFailure({
                  provider: adapter.provider,
                  message: `Timed out listing ${adapter.provider} models.`,
                  cause: LIST_TIMEOUT,
                }),
            }),
            Effect.catchDefect(
              (cause) =>
                new HarnessFailure({
                  provider: adapter.provider,
                  message: `Couldn't list ${adapter.provider} models.`,
                  cause,
                }),
            ),
          );
          // The backend owns the lookup, so canceling a viewer's request leaves it available to others.
          yield* Effect.forkIn(
            Effect.gen(function* () {
              const result = yield* Effect.exit(discover);
              const finishedAt = yield* Clock.currentTimeMillis;
              if (harness.listing === listing) {
                harness.models = Exit.isSuccess(result) ? result.value : [];
                listing.expiresAt = finishedAt + FRESH_FOR_MS;
                Deferred.doneUnsafe(listing.done, Effect.succeed(result));
              }
            }),
            scope,
            { uninterruptible: false },
          );
          return listing;
        }).pipe(Effect.uninterruptible);

      const read = (harness: HarnessModels) =>
        Effect.gen(function* () {
          for (;;) {
            const listing = yield* ensureListing(harness);
            const result = yield* Deferred.await(listing.done);
            if (result !== undefined && harness.listing === listing) return yield* result;
          }
        });

      const invalidate = (harness: HarnessModels) =>
        Effect.gen(function* () {
          const previous = harness.listing;
          delete harness.listing;
          harness.models = [];
          // Move current waiters to the replacement. An older lookup can finish, but can't publish.
          if (previous !== undefined) Deferred.doneUnsafe(previous.done, Effect.void);
          yield* ensureListing(harness);
        }).pipe(Effect.uninterruptible);

      const startup = yield* Effect.forEach(ordered, (harness) => Effect.ignore(read(harness)), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.forkIn(scope));

      return OfferedModels.of({
        all: Effect.gen(function* () {
          yield* Fiber.join(startup);
          yield* Effect.forEach(ordered, ensureListing, { discard: true });
          return ordered.flatMap((harness) => harness.models);
        }),
        list: (provider) => {
          const harness = harnesses.get(provider);
          return harness === undefined
            ? new HarnessUnavailable({
                provider,
                reason: "notInstalled",
                message: `No ${provider} adapter is installed.`,
              })
            : read(harness);
        },
        invalidate: (provider) => {
          const harness = harnesses.get(provider);
          if (harness === undefined) return Effect.void;
          // The next status check establishes the new baseline after a command or browser sign-in.
          return Effect.sync(() => {
            delete harness.status;
          }).pipe(Effect.andThen(invalidate(harness)), Effect.uninterruptible);
        },
        observe: (status) =>
          Effect.suspend(() => {
            const harness = harnesses.get(status.provider);
            if (harness === undefined) return Effect.void;
            const auth = status._tag === "HarnessInstalled" ? status.auth : undefined;
            const signedIn = auth?._tag === "LoggedIn";
            const observed =
              status._tag === "HarnessMissing"
                ? status._tag
                : JSON.stringify([
                    status.executablePath,
                    status.version,
                    status.auth._tag,
                    signedIn ? auth.method : undefined,
                    signedIn ? auth.plan : undefined,
                  ]);
            const previous = harness.status;
            harness.status = observed;
            // A status check can also spot a sign-in that finished during an earlier listing.
            const hasModels = harness.models.length > 0;
            const differsFromListing =
              harness.listing !== undefined &&
              harness.listing.expiresAt !== Infinity &&
              signedIn !== hasModels;
            return differsFromListing || (previous !== undefined && previous !== observed)
              ? invalidate(harness)
              : Effect.void;
          }).pipe(Effect.uninterruptible),
      });
    }),
  );
}

/**
 * The catalog leads spawn from without asking: each read applies the current roster (Settings → Roster)
 * to the latest model lists.
 */
export const CatalogLive = Layer.effect(
  Catalog,
  Effect.gen(function* () {
    const offered = yield* OfferedModels;
    const settings = yield* UserSettings;
    return Catalog.of({
      entries: Effect.gen(function* () {
        const models = yield* offered.all;
        const { roster } = yield* settings.get;
        return catalogEntries(rosterMembers(roster, models));
      }),
      models: offered.all,
    });
  }),
);
